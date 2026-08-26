import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
//#region src/host/gate.ts
/**
* Workspace gate for the /aionui-panel routes: canonicalize the requested
* project root and require it to be a registered workspace (or a directory
* inside one). This is the security boundary of the panel's fs/git routes —
* the browser may only read and mutate files under registered workspace
* roots, never arbitrary host directories.
* @module dsh-aionui-panel/host/gate
*/
/** The canonical prefix check: child must live inside (or equal) the root.
* Windows paths use backslash separators (join() output) — the prefix must
* match the root's own separator, and the comparison is case-insensitive. */
function isPathInside(root, child) {
	if (root === "" || child === "") return false;
	if (child === root) return true;
	const sep = root.includes("\\") ? "\\" : "/";
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return child.toLowerCase().startsWith(prefix.toLowerCase());
}
/**
* Production gate: canonicalize the requested root and require it to be a
* registered workspace path (or a subdirectory of one). The host's workspace
* registry owns canonicalization, so an unowned path is rejected outright.
* @param ctx - context carrying the workspace service.
* @returns the gate.
*/
function createWorkspaceGate(ctx) {
	return async (root) => {
		if (typeof root !== "string" || root === "") return {
			ok: false,
			error: {
				code: "workspace-unknown",
				message: "empty project root"
			}
		};
		let canonical;
		try {
			canonical = await realpath(root);
		} catch {
			return {
				ok: false,
				error: {
					code: "workspace-unknown",
					message: "path does not resolve on disk"
				}
			};
		}
		const workspaces = ctx.workspaceRegistry.list();
		for (const workspace of workspaces) if (isPathInside(workspace.path, canonical)) return {
			ok: true,
			canonical
		};
		return {
			ok: false,
			error: {
				code: "workspace-unknown",
				message: "path is not inside a registered workspace"
			}
		};
	};
}
//#endregion
//#region src/host/fs-service.ts
/**
* Host filesystem service for the panel: directory listing, file read (whole
* text, no size cap), text write with an mtime conflict check, filename search
* with directory pruning, delete (untracked discard), and a recursive watcher
* that emits change events. Every operation resolves against a gated project
* root and refuses to escape it (path traversal guard). Text is decoded utf-8;
* images come back as data URLs (capped) so the browser renders them without
* extra round trips.
*
* SSH-mode delegation: when the optional remote core is present and the
* requested root equals the active remote root, every fs operation rides the
* SSH engine instead of the local disk (list/read/write/search/delete), so
* the panel shows the remote workspace while the GUI is in SSH mode.
* @module dsh-aionui-panel/host/fs-service
*/
/** Image read cap (data URL payload budget). */
const IMAGE_CAP_BYTES = 8 << 20;
/** Filename-search caps (results and scanned entries). */
const SEARCH_HIT_CAP = 200;
const SEARCH_SCAN_CAP = 2e4;
/** Remote find max depth (the engine's exec shell quotes each argument). */
const SEARCH_MAX_DEPTH_REMOTE = 24;
/** Directories skipped by search (VS Code-like noise reduction). */
const SEARCH_SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules"]);
/** Directories never listed in the tree. */
const TREE_SKIP_DIRS = /* @__PURE__ */ new Set([".git"]);
/** Polling fallback interval when recursive watch is unavailable. */
const POLL_FALLBACK_MS = 3e3;
/** POSIX single-quote a remote shell argument (find -iname patterns). */
function shellQuote$1(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
* Resolve a relative path against the canonical root, realpath-checking the
* existing ancestors so a symlink cannot smuggle the operation outside the
* root. A path that does not yet exist (ENOENT) is verified through its
* nearest existing ancestor — a nonexistent tail cannot itself be a symlink.
* A path whose real path escapes the root is rejected with path-outside-root.
*/
async function resolveInsideRoot(root, rel) {
	if (rel.includes("\0")) return {
		ok: false,
		error: {
			code: "path-outside-root",
			message: "invalid path"
		}
	};
	const abs = join(root, rel);
	if (!isPathInside(root, abs)) return {
		ok: false,
		error: {
			code: "path-outside-root",
			message: `path escapes root: ${rel}`
		}
	};
	let probe = abs;
	for (let hop = 0; hop < 32; hop += 1) {
		let real;
		try {
			real = await realpath(probe);
		} catch (error) {
			if (error.code !== "ENOENT") return {
				ok: true,
				abs
			};
			const parent = dirname(probe);
			if (parent === probe) return {
				ok: true,
				abs
			};
			probe = parent;
			continue;
		}
		if (!isPathInside(root, real)) return {
			ok: false,
			error: {
				code: "path-outside-root",
				message: `path resolves outside root: ${rel}`
			}
		};
		return {
			ok: true,
			abs
		};
	}
	return {
		ok: false,
		error: {
			code: "path-outside-root",
			message: `path cannot be resolved: ${rel}`
		}
	};
}
/** True when the relative path is, or passes through, a .git component. */
function isGitPath(rel) {
	return rel.split("/").some((part) => part.toLowerCase() === ".git");
}
/** Case-insensitive alpha compare (dirs first, then files). */
function compareEntries(a, b) {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	const an = a.name.toLowerCase();
	const bn = b.name.toLowerCase();
	return an < bn ? -1 : an > bn ? 1 : 0;
}
/** The image probe: parse PNG/JPEG/GIF/WebP header dimensions (undefined on failure). */
function probeImageSize(data) {
	try {
		if (data.length >= 24 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return {
			width: data.readUInt32BE(16),
			height: data.readUInt32BE(20)
		};
		if (data.length >= 10 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
			let pos = 2;
			for (let segment = 0; segment < 16; segment += 1) {
				if (pos + 2 > data.length) return void 0;
				if (data[pos] !== 255) return void 0;
				while (pos < data.length && data[pos] === 255) pos += 1;
				if (pos >= data.length) return void 0;
				const marker = data[pos];
				pos += 1;
				if (marker === 1 || marker >= 208 && marker <= 215 || marker === 216) continue;
				if (marker === 192 || marker === 193 || marker === 194 || marker === 195 || marker === 197 || marker === 198 || marker === 199 || marker === 201 || marker === 202 || marker === 203 || marker === 205 || marker === 206 || marker === 207) {
					if (pos + 7 > data.length) return void 0;
					return {
						height: data.readUInt16BE(pos + 3),
						width: data.readUInt16BE(pos + 5)
					};
				}
				if (pos + 2 > data.length) return void 0;
				const length = data.readUInt16BE(pos);
				pos += length;
				if (pos < 0) return void 0;
			}
			return;
		}
		if (data.length >= 14 && data[0] === 71 && data[1] === 73 && data[2] === 70) return {
			width: data.readUInt16LE(6),
			height: data.readUInt16LE(8)
		};
		if (data.length >= 30 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80 && data[12] === 86 && data[13] === 80 && data[14] === 56 && data[15] === 88) {
			const size = (o) => data[o] | data[o + 1] << 8 | data[o + 2] << 16;
			return {
				width: size(24) + 1,
				height: size(27) + 1
			};
		}
	} catch {
		return;
	}
}
/** Derive the mime type for an image read from the extension, then the content. */
function imageMime(rel, data) {
	const ext = rel.split(".").pop()?.toLowerCase() ?? "";
	const byExt = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		ico: "image/x-icon",
		avif: "image/avif",
		bmp: "image/bmp"
	};
	if (byExt[ext]) return byExt[ext];
	if (data.length >= 3 && data[0] === 137 && data[1] === 80 && data[2] === 78) return "image/png";
	if (data.length >= 3 && data[0] === 255 && data[1] === 216) return "image/jpeg";
	return "application/octet-stream";
}
/**
* Filesystem service: gated listing/read/write/search/delete plus a change
* watcher. All relative paths are resolved against the gated root.
* @param gate - the workspace gate (host: registered workspace membership).
* @param getRemote - optional provider of the SSH workspace core (mode store +
*   engine). When present and the mode is remote, operations for the remote
*   root delegate to the SSH engine instead of the local disk.
*/
var FsService = class FsService {
	gate;
	getRemote;
	/**
	* Last-read content per absolute path (LRU-capped). Serves as the edit-diff
	* BASELINE: when a file changes on disk, the auto-open flow reads it and
	* diffs against this cached previous content — so an externally edited file
	* opens showing its red-delete / green-add delta instead of a blank state.
	*/
	contentCache = /* @__PURE__ */ new Map();
	static CACHE_CAP = 64;
	cacheSet(abs, content) {
		if (this.contentCache.size >= FsService.CACHE_CAP) {
			const oldest = this.contentCache.keys().next().value;
			if (oldest !== void 0) this.contentCache.delete(oldest);
		}
		this.contentCache.set(abs, content);
	}
	/** The previous content of a path (undefined when never read/written). */
	previousContent(abs) {
		return this.contentCache.get(abs);
	}
	constructor(gate, getRemote) {
		this.gate = gate;
		this.getRemote = getRemote;
	}
	/** The active remote target when root is the SSH-mode remote root. */
	remoteTarget(root) {
		const core = this.getRemote?.();
		if (core === void 0) return null;
		const state = core.store.getSnapshot();
		if (state.mode !== "remote" || state.alias === void 0 || state.remoteRoot === void 0) return null;
		if (root !== state.remoteRoot) return null;
		return {
			alias: state.alias,
			remoteRoot: state.remoteRoot,
			engine: core.engine
		};
	}
	/** True when root is the SSH-mode remote root (git is unavailable there). */
	isRemote(root) {
		return this.remoteTarget(root) !== null;
	}
	/** Verify a project root against the workspace gate (used by the SSE layer). */
	async verify(root) {
		const remote = this.remoteTarget(root);
		if (remote !== null) return {
			ok: true,
			canonical: remote.remoteRoot
		};
		return this.gate(root);
	}
	/** Resolve a remote-relative path against the remote root (no traversal). */
	remoteAbs(remoteRoot, rel) {
		if (rel.includes("\0") || rel.split("/").includes("..")) return null;
		if (rel === "") return remoteRoot;
		return remoteRoot.endsWith("/") ? remoteRoot + rel : `${remoteRoot}/${rel}`;
	}
	/** List one directory (relative path; '' = root). Sorted dirs-first alpha. */
	async list(root, rel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				const entries = await remote.engine.ls(remote.alias, abs);
				const out = [];
				for (const entry of entries) {
					if (entry.type === "dir" && TREE_SKIP_DIRS.has(entry.name)) continue;
					const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
					out.push({
						name: entry.name,
						path,
						isDir: entry.type === "dir",
						size: entry.type === "dir" ? 0 : entry.size,
						mtime: entry.type === "dir" ? 0 : entry.mtimeMs
					});
				}
				out.sort(compareEntries);
				return {
					root: remote.remoteRoot,
					entries: out
				};
			} catch {
				return {
					code: "not-found",
					message: `cannot list ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		let dirents;
		try {
			dirents = await readdir(resolved.abs, { withFileTypes: true });
		} catch {
			return {
				code: "not-found",
				message: `cannot list ${rel}`
			};
		}
		const out = [];
		for (const entry of dirents) {
			if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) out.push({
				name: entry.name,
				path,
				isDir: true,
				size: 0,
				mtime: 0
			});
		}
		const files = dirents.filter((entry) => !entry.isDirectory());
		const statted = await Promise.all(files.map(async (entry) => {
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			try {
				const info = await stat(join(resolved.abs, entry.name));
				return {
					name: entry.name,
					path,
					isDir: false,
					size: info.size,
					mtime: info.mtimeMs
				};
			} catch {
				return {
					name: entry.name,
					path,
					isDir: false,
					size: 0,
					mtime: 0
				};
			}
		}));
		out.push(...statted);
		out.sort(compareEntries);
		return {
			root: gated.canonical,
			entries: out
		};
	}
	/** Read one file for preview: text decoded utf-8 (whole file), images as data URLs. */
	async read(root, rel, asImage) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				const result = await remote.engine.readFile(remote.alias, abs);
				if (asImage) {
					if (result.content.length > IMAGE_CAP_BYTES) return {
						code: "read-failed",
						message: "image exceeds preview cap"
					};
					return {
						content: `data:${imageMime(rel, result.content)};base64,${result.content.toString("base64")}`,
						truncated: false,
						size: result.size,
						mtime: result.mtime,
						image: probeImageSize(result.content)
					};
				}
				return {
					content: result.content.toString("utf8"),
					truncated: false,
					size: result.size,
					mtime: result.mtime,
					previous: this.previousContent(abs)
				};
			} catch {
				return {
					code: "not-found",
					message: `cannot read ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		let data;
		let info;
		try {
			data = await readFile(resolved.abs);
			info = await stat(resolved.abs);
		} catch {
			return {
				code: "not-found",
				message: `cannot read ${rel}`
			};
		}
		if (info.isDirectory()) return {
			code: "is-directory",
			message: `${rel} is a directory`
		};
		if (asImage) {
			if (data.length > IMAGE_CAP_BYTES) return {
				code: "read-failed",
				message: "image exceeds preview cap"
			};
			return {
				content: `data:${imageMime(rel, data)};base64,${data.toString("base64")}`,
				truncated: false,
				size: data.length,
				mtime: info.mtimeMs,
				image: probeImageSize(data)
			};
		}
		const text = data.toString("utf8");
		const previous = this.previousContent(resolved.abs);
		this.cacheSet(resolved.abs, text);
		return {
			content: text,
			truncated: false,
			size: data.length,
			mtime: info.mtimeMs,
			previous
		};
	}
	/**
	* Read one file's raw bytes (the markdown image route): gated, traversal-
	* guarded, and .git-refusing. The bytes are streamed by the HTTP layer with
	* the derived mime so `<img>` tags can load workspace files directly.
	*/
	async readRaw(root, rel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (isGitPath(rel)) return {
				code: "path-outside-root",
				message: "refusing to read .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				const result = await remote.engine.readFile(remote.alias, abs);
				return {
					data: result.content,
					mime: imageMime(rel, result.content),
					size: result.size
				};
			} catch {
				return {
					code: "not-found",
					message: `cannot read ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (isGitPath(rel)) return {
			code: "path-outside-root",
			message: "refusing to read .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		let data;
		let info;
		try {
			info = await stat(resolved.abs);
		} catch {
			return {
				code: "not-found",
				message: `cannot read ${rel}`
			};
		}
		if (info.isDirectory()) return {
			code: "is-directory",
			message: `${rel} is a directory`
		};
		try {
			data = await readFile(resolved.abs);
		} catch {
			return {
				code: "not-found",
				message: `cannot read ${rel}`
			};
		}
		return {
			data,
			mime: imageMime(rel, data),
			size: data.length
		};
	}
	/** Write text content back, refusing when the file moved on disk (mtime conflict). */
	async write(root, rel, content, baseMtime) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (isGitPath(rel)) return {
				code: "path-outside-root",
				message: "refusing to touch .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				const result = await remote.engine.writeFile(remote.alias, abs, Buffer.from(content, "utf8"), baseMtime);
				this.cacheSet(abs, content);
				return { mtime: result.mtime };
			} catch (error) {
				if (String(error).includes("mtime conflict")) return {
					code: "write-conflict",
					message: "file changed on the remote since it was loaded"
				};
				return {
					code: "write-failed",
					message: `cannot write ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (isGitPath(rel)) return {
			code: "path-outside-root",
			message: "refusing to touch .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		try {
			let current;
			try {
				current = await stat(resolved.abs);
			} catch {
				current = { mtimeMs: 0 };
			}
			if (baseMtime !== void 0 && Number(current.mtimeMs) !== 0 && Math.abs(Number(current.mtimeMs) - baseMtime) > 1) return {
				code: "write-conflict",
				message: "file changed on disk since it was loaded"
			};
			await mkdir(dirname(resolved.abs), { recursive: true });
			await writeFile(resolved.abs, content, "utf8");
			const info = await stat(resolved.abs);
			this.cacheSet(resolved.abs, content);
			return { mtime: info.mtimeMs };
		} catch {
			return {
				code: "write-failed",
				message: `cannot write ${rel}`
			};
		}
	}
	/** Write one BINARY file (base64 payload) — the office editors save rebuilt
	*  docx/xlsx/pptx packages this way. Same mtime-conflict guard as write. */
	async writeBinary(root, rel, base64, baseMtime) {
		let buffer;
		try {
			buffer = Buffer.from(base64, "base64");
		} catch {
			return {
				code: "write-failed",
				message: "invalid base64 payload"
			};
		}
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (isGitPath(rel)) return {
				code: "path-outside-root",
				message: "refusing to touch .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				return { mtime: (await remote.engine.writeFile(remote.alias, abs, buffer, baseMtime)).mtime };
			} catch (error) {
				if (String(error).includes("mtime conflict")) return {
					code: "write-conflict",
					message: "file changed on the remote since it was loaded"
				};
				return {
					code: "write-failed",
					message: `cannot write ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (isGitPath(rel)) return {
			code: "path-outside-root",
			message: "refusing to touch .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		try {
			let current;
			try {
				current = await stat(resolved.abs);
			} catch {
				current = { mtimeMs: 0 };
			}
			if (baseMtime !== void 0 && Number(current.mtimeMs) !== 0 && Math.abs(Number(current.mtimeMs) - baseMtime) > 1) return {
				code: "write-conflict",
				message: "file changed on disk since it was loaded"
			};
			await mkdir(dirname(resolved.abs), { recursive: true });
			await writeFile(resolved.abs, buffer);
			return { mtime: (await stat(resolved.abs)).mtimeMs };
		} catch {
			return {
				code: "write-failed",
				message: `cannot write ${rel}`
			};
		}
	}
	/** Recursive filename search (case-insensitive substring), pruned at noise dirs. */
	async search(root, query) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return {
				query,
				hits: [],
				truncated: false
			};
			const safe = needle.replace(/[^a-z0-9._-]/g, "");
			const command = `find ${shellQuote$1(remote.remoteRoot)} -maxdepth ${SEARCH_MAX_DEPTH_REMOTE} \\( -not -path ${shellQuote$1("*/node_modules*")} \\) \\( -not -path ${shellQuote$1("*/.git*")} \\) -iname ${shellQuote$1(`*${safe}*`)} -printf '%y|%p\\n'`;
			try {
				const result = await remote.engine.exec(remote.alias, command, 2e4);
				if (!result.success && result.stderr !== "" && result.stdout === "") return {
					code: "search-failed",
					message: result.stderr.trim()
				};
				const hits = [];
				const lines = result.stdout.split("\n").filter((line) => line !== "");
				for (const line of lines) {
					const sep = line.indexOf("|");
					if (sep < 0) continue;
					const kind = line.slice(0, sep);
					const absPath = line.slice(sep + 1);
					if (absPath.startsWith(remote.remoteRoot)) {
						const rel = absPath.slice(remote.remoteRoot.length).replace(/^\/+/, "");
						if (rel === "") continue;
						const name = rel.split("/").pop() ?? rel;
						hits.push({
							path: rel,
							name,
							isDir: kind === "d"
						});
					}
					if (hits.length >= SEARCH_HIT_CAP) break;
				}
				const rank = (hit) => {
					const name = hit.name.toLowerCase();
					if (name === needle) return 0;
					if (name.startsWith(needle)) return 1;
					return 2;
				};
				hits.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
				return {
					query,
					hits,
					truncated: hits.length >= SEARCH_HIT_CAP
				};
			} catch {
				return {
					code: "search-failed",
					message: "remote search failed"
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		const needle = query.trim().toLowerCase();
		if (needle === "") return {
			query,
			hits: [],
			truncated: false
		};
		const hits = [];
		let scanned = 0;
		let truncated = false;
		const walk = async (rel, depth) => {
			if (truncated) return;
			const resolved = await resolveInsideRoot(gated.canonical, rel);
			if (!resolved.ok) return;
			let dirents;
			try {
				dirents = await readdir(resolved.abs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of dirents) {
				if (scanned >= SEARCH_SCAN_CAP) {
					truncated = true;
					return;
				}
				scanned += 1;
				const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
				if (entry.isDirectory()) {
					if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
					if (depth < 24 && !truncated) await walk(path, depth + 1);
					continue;
				}
				if (entry.name.toLowerCase().includes(needle)) {
					if (hits.length >= SEARCH_HIT_CAP) {
						truncated = true;
						return;
					}
					hits.push({
						path,
						name: entry.name,
						isDir: false
					});
				}
			}
		};
		try {
			await walk("", 0);
		} catch {
			return {
				code: "search-failed",
				message: "search walk failed"
			};
		}
		const rank = (hit) => {
			const name = hit.name.toLowerCase();
			if (name === needle) return 0;
			if (name.startsWith(needle)) return 1;
			return 2;
		};
		hits.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
		return {
			query,
			hits,
			truncated
		};
	}
	/** Delete a path (discard of untracked files). Recursive for directories.
	*  Local Windows deletes move into the Recycle Bin (Microsoft.VisualBasic
	*  SendToRecycleBin); remote deletes stay permanent (SFTP has no bin). */
	async delete(root, rel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (rel === "") return {
				code: "path-outside-root",
				message: "refusing to delete the root"
			};
			if (isGitPath(rel)) return {
				code: "path-outside-root",
				message: "refusing to touch .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				await remote.engine.rm(remote.alias, abs, true);
				return { ok: true };
			} catch {
				return {
					code: "write-failed",
					message: `cannot delete ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (rel === "") return {
			code: "path-outside-root",
			message: "refusing to delete the root"
		};
		if (isGitPath(rel)) return {
			code: "path-outside-root",
			message: "refusing to touch .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		if (process.platform === "win32") try {
			const literal = JSON.stringify(resolved.abs);
			execFileSync("powershell", [
				"-NoProfile",
				"-Command",
				`Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path -LiteralPath ${literal}) { $i = Get-Item -LiteralPath ${literal}; if ($i.PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($i.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($i.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin') } }`
			], {
				timeout: 2e4,
				stdio: "ignore"
			});
			return { ok: true };
		} catch {}
		try {
			await rm(resolved.abs, {
				recursive: true,
				force: true
			});
			return { ok: true };
		} catch {
			return {
				code: "write-failed",
				message: `cannot delete ${rel}`
			};
		}
	}
	/** Create a directory (recursive; local mkdir or remote `mkdir -p`). */
	async mkdir(root, rel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (rel === "" || isGitPath(rel)) return {
				code: "path-outside-root",
				message: "refusing to create under .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			if (abs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				await remote.engine.exec(remote.alias, `mkdir -p ${shellQuote$1(abs)}`);
				return { ok: true };
			} catch {
				return {
					code: "write-failed",
					message: `cannot create ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (rel === "" || isGitPath(rel)) return {
			code: "path-outside-root",
			message: "refusing to create under .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		if (!resolved.ok) return resolved.error;
		try {
			await mkdir(resolved.abs, { recursive: true });
			return { ok: true };
		} catch {
			return {
				code: "write-failed",
				message: `cannot create ${rel}`
			};
		}
	}
	/** Rename / move a path (local fs.rename or remote SFTP rename). */
	async rename(root, rel, newRel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (rel === "" || newRel === "" || isGitPath(rel) || isGitPath(newRel)) return {
				code: "path-outside-root",
				message: "refusing to rename the root or .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			const newAbs = this.remoteAbs(remote.remoteRoot, newRel);
			if (abs === null || newAbs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				await remote.engine.rename(remote.alias, abs, newAbs);
				return { ok: true };
			} catch {
				return {
					code: "write-failed",
					message: `cannot rename ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (rel === "" || newRel === "" || isGitPath(rel) || isGitPath(newRel)) return {
			code: "path-outside-root",
			message: "refusing to rename the root or .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		const resolvedNew = await resolveInsideRoot(gated.canonical, newRel);
		if (!resolved.ok) return resolved.error;
		if (!resolvedNew.ok) return resolvedNew.error;
		try {
			await rename(resolved.abs, resolvedNew.abs);
			return { ok: true };
		} catch {
			return {
				code: "write-failed",
				message: `cannot rename ${rel}`
			};
		}
	}
	/** Copy a path into the same tree (read + write; local or remote). */
	async copy(root, rel, newRel) {
		const remote = this.remoteTarget(root);
		if (remote !== null) {
			if (rel === "" || newRel === "" || isGitPath(rel) || isGitPath(newRel)) return {
				code: "path-outside-root",
				message: "refusing to copy the root or .git"
			};
			const abs = this.remoteAbs(remote.remoteRoot, rel);
			const newAbs = this.remoteAbs(remote.remoteRoot, newRel);
			if (abs === null || newAbs === null) return {
				code: "path-outside-root",
				message: "path escapes root"
			};
			try {
				const info = await remote.engine.readFile(remote.alias, abs);
				await remote.engine.writeFile(remote.alias, newAbs, info.content);
				return { ok: true };
			} catch {
				return {
					code: "write-failed",
					message: `cannot copy ${rel}`
				};
			}
		}
		const gated = await this.gate(root);
		if (!gated.ok) return gated.error;
		if (rel === "" || newRel === "" || isGitPath(rel) || isGitPath(newRel)) return {
			code: "path-outside-root",
			message: "refusing to copy the root or .git"
		};
		const resolved = await resolveInsideRoot(gated.canonical, rel);
		const resolvedNew = await resolveInsideRoot(gated.canonical, newRel);
		if (!resolved.ok) return resolved.error;
		if (!resolvedNew.ok) return resolvedNew.error;
		try {
			await mkdir(dirname(resolvedNew.abs), { recursive: true });
			await copyFile(resolved.abs, resolvedNew.abs);
			return { ok: true };
		} catch {
			return {
				code: "write-failed",
				message: `cannot copy ${rel}`
			};
		}
	}
	/**
	* Watch a root recursively and emit change events (debounced + batched).
	* The callback receives the changed path RELATIVE to the root ('/' separ-
	* ated). Windows fs.watch sometimes reports a null filename; the watcher
	* then falls back to a scan-diff (recursive, .git/node_modules pruned) so
	* concrete paths still reach the client.
	* @param root - project root to watch (gated on connect).
	* @param onChange - fired (debounced) with the relative changed path.
	* @returns disposer.
	*/
	watch(root, onChange) {
		if (this.remoteTarget(root) !== null) return () => {};
		let disposed = false;
		let timer;
		let pollTimer;
		let scanTimer;
		let watcher;
		let scanLock;
		let lastScan;
		let pendingRels = /* @__PURE__ */ new Set();
		/**
		* Re-scan the tree and emit every path whose signature changed since the
		* last scan (added / modified / deleted). Prunes .git + node_modules.
		*/
		const scanAndEmit = async () => {
			if (disposed) return;
			const gated = await this.gate(root);
			if (!gated.ok || disposed) return;
			if (scanLock !== void 0) {
				await scanLock;
				return;
			}
			scanLock = (async () => {
				const current = await this.scanTree(gated.canonical);
				const prev = lastScan;
				lastScan = current;
				if (prev === void 0 || disposed) return;
				const changes = [];
				for (const [rel, sig] of current) if (!prev.has(rel) || prev.get(rel) !== sig) changes.push(rel);
				for (const rel of prev.keys()) if (!current.has(rel)) changes.push(rel);
				for (const rel of changes) onChange(rel);
			})();
			await scanLock;
			scanLock = void 0;
		};
		const fire = (rel) => {
			if (rel === void 0) {
				if (scanTimer !== void 0) return;
				scanTimer = setTimeout(() => {
					scanTimer = void 0;
					scanAndEmit();
				}, 150);
				return;
			}
			pendingRels.add(rel);
			if (timer !== void 0) return;
			timer = setTimeout(() => {
				timer = void 0;
				if (disposed) return;
				const batch = pendingRels;
				pendingRels = /* @__PURE__ */ new Set();
				if (batch.size === 0) return;
				(async () => {
					const gated = await this.gate(root);
					if (!gated.ok) {
						for (const rel of batch) onChange(rel);
						return;
					}
					for (const rel of batch) {
						const resolved = await resolveInsideRoot(gated.canonical, rel);
						if (!resolved.ok) {
							onChange(rel);
							continue;
						}
						try {
							if (!(await stat(resolved.abs)).isDirectory()) onChange(rel);
						} catch {
							onChange(rel);
						}
					}
				})();
			}, 150);
		};
		const startPolling = () => {
			if (pollTimer !== void 0) return;
			scanAndEmit();
			pollTimer = setInterval(() => {
				scanAndEmit();
			}, POLL_FALLBACK_MS);
		};
		this.gate(root).then(async (gated) => {
			if (!gated.ok || disposed) return;
			lastScan = await this.scanTree(gated.canonical);
			if (disposed) return;
			try {
				watcher = watch(gated.canonical, { recursive: true }, (_event, filename) => {
					const rel = typeof filename === "string" && filename !== "" ? filename.replace(/\\/g, "/") : void 0;
					fire(rel);
				});
				watcher.on("error", () => {
					if (disposed) return;
					watcher?.close();
					watcher = void 0;
					startPolling();
				});
			} catch {
				watcher = void 0;
				startPolling();
			}
		});
		return () => {
			disposed = true;
			if (timer !== void 0) clearTimeout(timer);
			if (pollTimer !== void 0) clearInterval(pollTimer);
			if (scanTimer !== void 0) clearTimeout(scanTimer);
			watcher?.close();
		};
	}
	/**
	* Recursive snapshot of a root: rel -> `${size}:${mtimeMs}` signature for
	* every file (directories are covered by their descendants; .git and
	* node_modules are pruned — their churn is never user code). Bounded depth
	* keeps pathological trees from stalling the poll.
	*/
	async scanTree(rootAbs, depth = 0) {
		const out = /* @__PURE__ */ new Map();
		if (depth > 10) return out;
		let entries;
		try {
			entries = await readdir(rootAbs, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const abs = join(rootAbs, entry.name);
			if (entry.isDirectory()) {
				const sub = await this.scanTree(abs, depth + 1);
				for (const [rel, sig] of sub) out.set(rel, sig);
			} else try {
				const info = await stat(abs);
				out.set(abs.slice(this.rootLenOf(rootAbs) + 1).replace(/\\/g, "/"), `${info.size}:${info.mtimeMs}`);
			} catch {}
		}
		return out;
	}
	/** Root-relative length of a canonical root (for slice-based rel paths). */
	rootLenOf(rootAbs) {
		return rootAbs.endsWith("/") || rootAbs.endsWith("\\") ? rootAbs.length - 1 : rootAbs.length;
	}
};
//#endregion
//#region src/host/git-service.ts
/**
* Host git service for the SCM tab: working-tree status (porcelain v1, -z),
* stage/unstage/discard batches, all scoped to the gated project root and
* executed through the managed subprocess seam. Parsing is pure and exported
* for tests; the service only wraps the runner. Discard never touches the
* staged side (the index is only ever rewritten by stage/unstage), matching
* the "discard = worktree side" contract.
* @module dsh-aionui-panel/host/git-service
*/
/** Collected-output cap for one git command. */
const OUTPUT_CAP_BYTES = 1 << 20;
/** Quote one argument for the cmd/sh wrapper (spaces and quotes). */
function shellArg(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, "\"\"")}"` : arg;
}
/**
* Production runner over `ctx.subprocess`: one managed child per command.
* The command is wrapped through the platform shell (cmd /c or sh -c) like
* the exec seam — the sandboxed subprocess provider reliably runs shell
* entrypoints, while a bare `git` name may be unresolvable from its scrubbed
* PATH (which is why the earlier direct-spawn variant failed).
*/
function subprocessRunner(ctx) {
	return { async run(argv, cwd) {
		const command = argv.map(shellArg).join(" ");
		const spec = {
			argv: process.platform === "win32" ? [
				"cmd",
				"/c",
				`git ${command}`
			] : [
				"sh",
				"-c",
				`git ${command}`
			],
			cwd,
			env: process.platform === "win32" ? {
				...process.env,
				PYTHONIOENCODING: "utf-8",
				PYTHONUTF8: "1"
			} : void 0,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: OUTPUT_CAP_BYTES },
				stderr: { maxBytes: OUTPUT_CAP_BYTES }
			},
			graceMs: 1e4
		};
		const handle = ctx.subprocess.spawn(spec);
		const outcome = await handle.done;
		const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
		const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
		return {
			exitCode: outcome.exitCode,
			stdout,
			stderr
		};
	} };
}
/** Map one porcelain letter to the row state (unknown letters stay unknown). */
function porcelainState(letter) {
	switch (letter) {
		case "A": return "created";
		case "M": return "modified";
		case "D": return "deleted";
		case "R": return "renamed";
		case "C": return "created";
		case "U": return "conflicted";
		case "?": return "untracked";
		default: return "unknown";
	}
}
/**
* Parse `git status --porcelain=v1 -z` output into staged/unstaged/untracked
* rows. With -z every entry is NUL-terminated; rename entries carry two paths
* (old and new). Pure — exported for tests.
* @param output - raw porcelain v1 -z output.
* @returns the three change groups.
*/
function parsePorcelain(output) {
	const staged = [];
	const unstaged = [];
	const untracked = [];
	if (output === "") return {
		staged,
		unstaged,
		untracked
	};
	const fields = output.split("\0");
	for (let i = 0; i < fields.length; i += 1) {
		const field = fields[i];
		if (field === "") continue;
		const x = field[0] ?? " ";
		const y = field[1] ?? " ";
		const path = field.slice(3);
		if (x === "?" && y === "?") {
			untracked.push({
				path,
				state: "untracked",
				staged: false
			});
			continue;
		}
		if (x === "R" || x === "C") {
			const oldPath = path;
			const newPath = fields[i + 1] ?? oldPath;
			i += 1;
			staged.push({
				path: newPath,
				oldPath,
				state: porcelainState(x),
				staged: true
			});
			if (y !== " ") unstaged.push({
				path: newPath,
				oldPath,
				state: porcelainState(y),
				staged: false
			});
			continue;
		}
		if (x !== " ") staged.push({
			path,
			state: porcelainState(x),
			staged: true
		});
		if (y !== " ") unstaged.push({
			path,
			state: porcelainState(y),
			staged: false
		});
	}
	return {
		staged,
		unstaged,
		untracked
	};
}
/** Parse the porcelain row set into the status view shape. */
function parseStatusView(root, branch, output) {
	const { staged, unstaged, untracked } = parsePorcelain(output);
	return {
		root,
		branch,
		staged,
		unstaged,
		untracked
	};
}
/** The not-a-repository verdict for status reads. */
const NO_REPO = {
	code: "git-unavailable",
	message: "not a git repository"
};
/**
* Workspace-scoped git operations. Every method passes the gate, resolves the
* repository root, and rejects non-repositories with a stable error.
* @param runner - the spawn seam.
* @param gate - workspace-membership gate.
* @param fsDelete - delete seam for untracked discard (host: FsService.delete).
*/
var GitService = class {
	runner;
	gate;
	fsDelete;
	constructor(runner, gate, fsDelete) {
		this.runner = runner;
		this.gate = gate;
		this.fsDelete = fsDelete;
	}
	/** Resolve the gated canonical root and the repository top-level. */
	async repo(root) {
		const gated = await this.gate(root);
		if (!gated.ok) return {
			ok: false,
			error: gated.error
		};
		const result = await this.run(["rev-parse", "--show-toplevel"], gated.canonical);
		if (result.exitCode !== 0) return {
			ok: false,
			error: NO_REPO
		};
		let repo = result.stdout.trim();
		if (process.platform === "win32") repo = repo.replace(/\//g, "\\");
		if (repo === "" || !isPathInside(repo, gated.canonical)) return {
			ok: false,
			error: NO_REPO
		};
		return {
			ok: true,
			root: gated.canonical,
			repo
		};
	}
	/** Run one git invocation and classify failures. */
	async run(argv, cwd) {
		return this.runner.run(argv, cwd);
	}
	/** The repo status view; null when the root is not a repository. */
	async status(root) {
		const repo = await this.repo(root);
		if (!repo.ok) return repo.error.code === "git-unavailable" ? null : repo.error;
		const [branchResult, statusResult] = await Promise.all([this.run([
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		], repo.repo), this.run([
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all"
		], repo.repo)]);
		const branch = branchResult.stdout.trim() === "HEAD" ? "" : branchResult.stdout.trim();
		return parseStatusView(repo.root, branch, statusResult.stdout);
	}
	/** The repo root for the watch layer (null when not a repository). */
	async repoRoot(root) {
		const repo = await this.repo(root);
		return repo.ok ? repo.repo : null;
	}
	/**
	* The unified diff of one path ('' when there is no diff to show). Staged
	* paths diff the index against HEAD (`--cached`); unstaged paths diff the
	* worktree against the index. Untracked paths have no index/HEAD entry, so
	* they diff against /dev/null (the canonical new-file shape); its exit code
	* is 1 — differences exist — which is a success here, not a failure.
	*/
	async diff(root, path, staged) {
		const repo = await this.repo(root);
		if (!repo.ok) return repo.error;
		const abs = join(repo.repo, path);
		if (!isPathInside(repo.repo, abs)) return {
			code: "path-outside-root",
			message: "path outside the repository"
		};
		const rel = relative(repo.repo, abs);
		const result = (await this.run([
			"ls-files",
			"--error-unmatch",
			"--",
			rel
		], repo.repo)).exitCode !== 0 ? await this.run([
			"diff",
			"--no-index",
			"--",
			"/dev/null",
			rel
		], repo.repo) : staged ? await this.run([
			"diff",
			"--cached",
			"--",
			rel
		], repo.repo) : await this.run([
			"diff",
			"--",
			rel
		], repo.repo);
		if (result.exitCode !== 0 && result.exitCode !== 1) return {
			code: "git-failed",
			message: "git diff failed"
		};
		return { content: result.stdout };
	}
	/** Verify paths stay inside the repo root (defense in depth). */
	pathsInside(repo, paths) {
		return paths.map((p) => join(repo, p)).filter((p) => isPathInside(repo, p)).map((p) => p);
	}
	/** Stage paths (git add). Batch result reflects the post-op status. */
	async stage(root, paths) {
		return this.batch(root, paths, async (repo, inside) => {
			return (await this.run([
				"add",
				"--",
				...inside
			], repo)).exitCode === 0;
		});
	}
	/** Unstage paths (git restore --staged). */
	async unstage(root, paths) {
		return this.batch(root, paths, async (repo, inside) => {
			return (await this.run([
				"restore",
				"--staged",
				"--",
				...inside
			], repo)).exitCode === 0;
		});
	}
	/**
	* Discard paths (worktree side only). Tracked paths are restored from the
	* index; untracked paths are deleted through the fs seam. The batch reports
	* applied/failed per path.
	*/
	async discard(root, paths) {
		const repo = await this.repo(root);
		if (!repo.ok) return repo.error;
		const inside = this.pathsInside(repo.repo, paths);
		const applied = [];
		const failed = [];
		for (const p of paths) {
			const abs = join(repo.repo, p);
			if (!inside.includes(abs)) {
				failed.push(p);
				continue;
			}
			if ((await this.run([
				"ls-files",
				"--error-unmatch",
				"--",
				":(literal)" + p
			], repo.repo)).exitCode !== 0) {
				try {
					const real = await realpath(join(repo.repo, p));
					if (!isPathInside(repo.repo, real)) {
						failed.push(p);
						continue;
					}
				} catch {}
				const rel = relative(repo.root, join(repo.repo, p));
				if (rel === ".." || rel.startsWith("../")) {
					failed.push(p);
					continue;
				}
				const deleted = await this.fsDelete(repo.root, rel);
				if ("ok" in deleted && deleted.ok) applied.push(p);
				else failed.push(p);
				continue;
			}
			if ((await this.run([
				"restore",
				"--worktree",
				"--",
				":(literal)" + p
			], repo.repo)).exitCode === 0) applied.push(p);
			else failed.push(p);
		}
		return {
			applied,
			failed
		};
	}
	/** Shared batch plumbing: gate, repo resolve, path filter, run the op. */
	async batch(root, paths, op) {
		const repo = await this.repo(root);
		if (!repo.ok) return repo.error;
		const inside = this.pathsInside(repo.repo, paths);
		const ok = inside.length > 0 ? await op(repo.repo, inside) : true;
		if (!ok) return {
			code: "git-failed",
			message: "git operation failed"
		};
		return {
			applied: ok ? paths.filter((p) => inside.includes(join(repo.repo, p))) : [],
			failed: paths.filter((p) => !inside.includes(join(repo.repo, p)))
		};
	}
};
//#endregion
//#region src/host/routes.ts
const OK = (value) => ({
	ok: true,
	value
});
const FAIL = (error) => ({
	ok: false,
	error
});
/** Structural request failure (never a workspace fault). */
const BAD_REQUEST = {
	code: "internal",
	message: "malformed request"
};
/** Poll interval for git-status changes while subscribers are connected. */
const GIT_POLL_MS = 2e3;
/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15e3;
/** Read a JSON request body into an unknown value; null when unparseable. */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		chunks.push(buffer);
		total += buffer.length;
		if (total > 64 << 20) return null;
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
/** Extract the required string field from a JSON object payload. */
function strField(payload, key) {
	if (typeof payload !== "object" || payload === null) return null;
	const value = payload[key];
	return typeof value === "string" && value !== "" ? value : null;
}
/** Extract a string field, accepting the empty string as a value. */
function strOrEmpty(payload, key) {
	if (typeof payload !== "object" || payload === null) return null;
	const value = payload[key];
	return typeof value === "string" ? value : null;
}
/** Extract a string array field (defaults to []). */
function strArray(payload, key) {
	if (typeof payload !== "object" || payload === null) return null;
	const value = payload[key];
	if (value === void 0) return [];
	if (!Array.isArray(value)) return null;
	if (!value.every((item) => typeof item === "string")) return null;
	return value;
}
/** Write one JSON envelope response. */
function json(res, envelope, status = 200) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(envelope));
}
/**
* Register the /aionui-panel routes (prefix for JSON, exact for the SSE
* stream — longest-prefix-wins keeps them disjoint).
* @param ctx - context carrying the webServer service.
* @param fs - the gated filesystem service.
* @param git - the gated git service.
* @param exec - the command-run seam (local subprocess or remote engine).
* @returns the route disposers.
*/
function registerPanelRoutes(ctx, fs, git, exec) {
	const subscribers = /* @__PURE__ */ new Set();
	let gitTimer;
	let heartbeatTimer;
	const push = (subscriber, payload) => {
		subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
	};
	let polling = false;
	const pollGit = async () => {
		if (polling) return;
		polling = true;
		try {
			await Promise.all([...subscribers].map(async (subscriber) => {
				try {
					if (fs.isRemote(subscriber.root)) return;
					const status = await git.status(subscriber.root);
					if (status === null || typeof status === "object" && "code" in status) return;
					const key = `${status.branch}|${JSON.stringify(status.staged)}|${JSON.stringify(status.unstaged)}|${JSON.stringify(status.untracked)}`;
					if (key === subscriber.lastGit) return;
					subscriber.lastGit = key;
					push(subscriber, {
						kind: "git",
						status
					});
				} catch (error) {
					ctx.logger.warn(`dsh-aionui-panel: git poll failed for ${subscriber.root}: ${String(error)}`);
				}
			}));
		} finally {
			polling = false;
		}
	};
	/**
	* GET /aionui-panel/raw: stream one workspace file (markdown image srcs).
	* Gated like every other operation; the bytes go out with the derived mime
	* so an `<img>` can load them. No validators are negotiated, so the browser
	* revalidates every time — a re-edited image never shows stale bytes.
	*/
	const serveRaw = async (url, res) => {
		const root = url.searchParams.get("root");
		const path = url.searchParams.get("path");
		if (root === null || root === "" || path === null || path === "") {
			json(res, FAIL(BAD_REQUEST), 400);
			return;
		}
		const result = await fs.readRaw(root, path);
		if (!("data" in result)) {
			const status = result.code === "path-outside-root" || result.code === "is-directory" ? 403 : 404;
			json(res, FAIL(result), status);
			return;
		}
		res.writeHead(200, {
			"content-type": result.mime,
			"content-length": result.size,
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff"
		});
		res.end(result.data);
	};
	const handler = async (req, res) => {
		if (req.method === "GET") {
			const url = new URL(req.url ?? "/", "http://x");
			if (url.pathname === "/aionui-panel/raw") {
				await serveRaw(url, res);
				return;
			}
			res.writeHead(405);
			res.end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			json(res, FAIL(BAD_REQUEST), 415);
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		const payload = await readJsonBody(req);
		if (payload === null) {
			json(res, FAIL(BAD_REQUEST));
			return;
		}
		const root = strField(payload, "root");
		if (root === null) {
			json(res, FAIL(BAD_REQUEST));
			return;
		}
		switch (pathname) {
			case "/aionui-panel/list": {
				const path = strField(payload, "path") ?? "";
				const result = await fs.list(root, path);
				json(res, "entries" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/read": {
				const path = strField(payload, "path");
				if (path === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const asImage = typeof payload === "object" && payload !== null ? payload.asImage === true : false;
				const result = await fs.read(root, path, asImage);
				json(res, "content" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/write": {
				const path = strField(payload, "path");
				const content = strOrEmpty(payload, "content");
				if (path === null || content === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const rawBase = typeof payload === "object" && payload !== null ? payload.baseMtime : void 0;
				const baseMtime = typeof rawBase === "number" && Number.isFinite(rawBase) ? rawBase : void 0;
				const result = await fs.write(root, path, content, baseMtime);
				json(res, "mtime" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/write-binary": {
				const path = strField(payload, "path");
				const base64 = strField(payload, "base64");
				if (path === null || base64 === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const rawBase = typeof payload === "object" && payload !== null ? payload.baseMtime : void 0;
				const baseMtime = typeof rawBase === "number" && Number.isFinite(rawBase) ? rawBase : void 0;
				const result = await fs.writeBinary(root, path, base64, baseMtime);
				json(res, "mtime" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/search": {
				const query = strField(payload, "query") ?? "";
				const result = await fs.search(root, query);
				json(res, "hits" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/delete": {
				const path = strField(payload, "path");
				if (path === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await fs.delete(root, path);
				json(res, "ok" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/mkdir": {
				const path = strField(payload, "path");
				if (path === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await fs.mkdir(root, path);
				json(res, "ok" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/rename": {
				const path = strField(payload, "path");
				const newPath = strField(payload, "newPath");
				if (path === null || newPath === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await fs.rename(root, path, newPath);
				json(res, "ok" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/copy": {
				const path = strField(payload, "path");
				const newPath = strField(payload, "newPath");
				if (path === null || newPath === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await fs.copy(root, path, newPath);
				json(res, "ok" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/exec": {
				if (exec === void 0) {
					json(res, FAIL({
						code: "internal",
						message: "exec seam unavailable"
					}));
					return;
				}
				const command = strField(payload, "command");
				const rawCwd = typeof payload === "object" && payload !== null ? payload.cwd : void 0;
				const cwd = typeof rawCwd === "string" && rawCwd !== "" ? rawCwd : void 0;
				if (command === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				try {
					const result = await exec.run(command, cwd, 6e4);
					json(res, OK(result));
				} catch (error) {
					json(res, FAIL({
						code: "internal",
						message: error instanceof Error ? error.message : String(error)
					}));
				}
				return;
			}
			case "/aionui-panel/git-status": {
				if (fs.isRemote(root)) {
					json(res, OK(null));
					return;
				}
				const result = await git.status(root);
				json(res, result === null ? OK(null) : "root" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/git-diff": {
				if (fs.isRemote(root)) {
					json(res, FAIL({
						code: "git-unavailable",
						message: "git is unavailable over SSH"
					}));
					return;
				}
				const path = strField(payload, "path");
				if (path === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const staged = typeof payload === "object" && payload !== null ? payload.staged === true : false;
				const result = await git.diff(root, path, staged);
				json(res, "content" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/git-stage": {
				if (fs.isRemote(root)) {
					json(res, FAIL({
						code: "git-unavailable",
						message: "git is unavailable over SSH"
					}));
					return;
				}
				const paths = strArray(payload, "paths");
				if (paths === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await git.stage(root, paths);
				json(res, "applied" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/git-unstage": {
				if (fs.isRemote(root)) {
					json(res, FAIL({
						code: "git-unavailable",
						message: "git is unavailable over SSH"
					}));
					return;
				}
				const paths = strArray(payload, "paths");
				if (paths === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await git.unstage(root, paths);
				json(res, "applied" in result ? OK(result) : FAIL(result));
				return;
			}
			case "/aionui-panel/git-discard": {
				if (fs.isRemote(root)) {
					json(res, FAIL({
						code: "git-unavailable",
						message: "git is unavailable over SSH"
					}));
					return;
				}
				const paths = strArray(payload, "paths");
				if (paths === null) {
					json(res, FAIL(BAD_REQUEST));
					return;
				}
				const result = await git.discard(root, paths);
				json(res, "applied" in result ? OK(result) : FAIL(result));
				return;
			}
			default:
				res.writeHead(404);
				res.end();
		}
	};
	const sse = async (req, res) => {
		const root = new URL(req.url ?? "/", "http://x").searchParams.get("root");
		if (root === null || root === "") {
			res.writeHead(400);
			res.end();
			return;
		}
		const gated = await fs.verify(root);
		if (!gated.ok) {
			json(res, FAIL(gated.error), 400);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		res.write("retry: 2000\n\n");
		const subscriber = {
			root: gated.canonical,
			lastGit: "",
			res
		};
		subscribers.add(subscriber);
		if (gitTimer === void 0) gitTimer = setInterval(pollGit, GIT_POLL_MS);
		if (heartbeatTimer === void 0) heartbeatTimer = setInterval(() => {
			for (const current of subscribers) current.res.write(": ping\n\n");
		}, HEARTBEAT_MS);
		const disposeWatch = fs.watch(gated.canonical, (rel) => {
			push(subscriber, {
				kind: "fs",
				path: rel
			});
		});
		req.on("close", () => {
			disposeWatch();
			subscribers.delete(subscriber);
			if (subscribers.size === 0) {
				if (gitTimer !== void 0) clearInterval(gitTimer);
				if (heartbeatTimer !== void 0) clearInterval(heartbeatTimer);
				gitTimer = void 0;
				heartbeatTimer = void 0;
			}
		});
	};
	const disposers = [ctx.webServer.register({
		kind: "prefix",
		path: "/aionui-panel",
		handler
	}), ctx.webServer.register({
		kind: "exact",
		path: "/aionui-panel/events",
		handler: sse
	})];
	return () => {
		for (const dispose of disposers) dispose();
		if (gitTimer !== void 0) clearInterval(gitTimer);
		if (heartbeatTimer !== void 0) clearInterval(heartbeatTimer);
		for (const subscriber of subscribers) subscriber.res.end();
		subscribers.clear();
	};
}
//#endregion
//#region src/index.ts
/** Required services: the route registry, the managed subprocess seam, the workspace registry, and the prompt band. */
const inject = [
	"webServer",
	"subprocess",
	"workspaceRegistry",
	"systemPrompt"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210;
/** POSIX single-quote a shell argument (the remote exec wraps `cd <dir> &&`). */
function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const AIONUI_PANEL_GUIDANCE = "本机已安装 dsh-aionui-panel 插件（DSH Web GUI 的右侧面板系统）：项目会话打开时，聊天区右侧出现「预览」与「文件/变更」两块面板。能力：Explorer 文件树（点击文件在预览面板打开、整行点击展开文件夹、按文件名搜索定位）；Preview 多 tab 预览（markdown/html/code/diff/csv/pdf/office/图片/文本等格式，支持源码/预览切换、分屏编辑、保存）；SCM 变更面板（真实 git stage/unstage/discard）；面板宽度可拖拽调整（Explorer 220~500px、Preview 340~1200px），双击把手复位默认宽度，折叠状态与宽度按项目持久化（localStorage）。数据源为当前会话工作目录的真实文件系统与真实 git 仓库，宿主进程经 /aionui-panel/* 路由提供。SSH 模式（dsh-ssh-workspace）下同一面板自动切换为远程文件树与远程编辑。用户提到「右侧面板 / 预览面板 / 文件树 / 变更面板」时即指本插件，请据此协作。";
/**
* Mount the panel data services and their routes.
* @param ctx - context carrying webServer, subprocess, workspaceRegistry, systemPrompt.
*/
function apply(ctx) {
	const gate = createWorkspaceGate(ctx);
	const getRemote = () => ctx.get("easysshCore");
	const fs = new FsService(gate, getRemote);
	const git = new GitService(subprocessRunner(ctx), gate, (root, rel) => fs.delete(root, rel));
	const exec = { async run(command, cwd, timeoutMs) {
		const remote = getRemote();
		const state = remote?.store.getSnapshot();
		if (remote !== void 0 && state?.mode === "remote" && state.alias !== void 0 && state.remoteRoot !== void 0) try {
			const wrapped = cwd !== void 0 && cwd !== "" ? `cd ${shellQuote(cwd)} && ${command}` : command;
			const result = await remote.engine.exec(state.alias, wrapped, timeoutMs ?? 6e4);
			return {
				ok: result.success,
				code: result.success ? 0 : 1,
				stdout: result.stdout,
				stderr: result.stderr
			};
		} catch (error) {
			return {
				ok: false,
				code: 1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error)
			};
		}
		try {
			const spec = {
				argv: process.platform === "win32" ? [
					"cmd",
					"/c",
					command
				] : [
					"sh",
					"-c",
					command
				],
				cwd: cwd ?? process.cwd(),
				env: process.platform === "win32" ? {
					...process.env,
					PYTHONIOENCODING: "utf-8",
					PYTHONUTF8: "1"
				} : void 0,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 4 << 20 },
					stderr: { maxBytes: 4 << 20 }
				},
				graceMs: 1e4
			};
			const handle = ctx.subprocess.spawn(spec);
			const outcome = await handle.done;
			const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
			const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
			return {
				ok: outcome.exitCode === 0,
				code: outcome.exitCode,
				stdout,
				stderr
			};
		} catch (error) {
			return {
				ok: false,
				code: 1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error)
			};
		}
	} };
	ctx.effect(() => registerPanelRoutes(ctx, fs, git, exec), "dsh-aionui-panel: /aionui-panel routes");
	ctx.effect(() => ctx.systemPrompt.section({
		name: "plugin:aionui-panel",
		order: SECTION_ORDER,
		text: AIONUI_PANEL_GUIDANCE
	}), "dsh-aionui-panel: prompt section");
}
//#endregion
export { AIONUI_PANEL_GUIDANCE, apply, inject };
