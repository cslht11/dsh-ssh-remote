# 第三方开源组件声明（Third-Party Notices）

本项目基于以下开源组件开发。所有组件的许可证要求均在此说明，并在分发中保留各自的版权声明与许可文本。

## 1. dsh-remote（本项目的基础）

- **项目**：[flymysql/dsh-remote](https://github.com/flymysql/dsh-remote)
- **npm**：[dsh-remote](https://www.npmjs.com/package/dsh-remote)
- **作者**：flymysql（<flyphp@outlook.com>）
- **版本**：0.5.10
- **许可证**：MIT License
- **用途**：SSH 连接池、SFTP 双向同步、远程工作区、机器注册表、`rw_*` 工具及前端设置面板的**底层实现**（本项目 fork 自它，并做了多池并行与 rc.8 适配改造）
- **版权声明**：

```
MIT License

Copyright (c) 2026 dsh-remote contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. ssh2（运行时依赖）

- **npm**：[ssh2](https://www.npmjs.com/package/ssh2)
- **作者**：Brian White（mscdex）
- **许可证**：MIT License
- **用途**：SSH/SFTP 底层协议实现（连接、认证、shell 执行、文件传输）

## 3. @deepseek-ai/schemastery（运行时依赖）

- **许可证**：随 DeepSeek Harness 分发（MIT）
- **用途**：插件配置 schema 定义

## 4. DeepSeek Harness（DSH，宿主平台）

- **项目**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **许可证**：以官方仓库 [LICENSE](https://github.com/deepseek-ai/deepseek-harness) 为准
- **用法**：本项目是 DSH 的插件，运行于 DSH 的插件体系内；插件本体代码与本仓库其余原创内容另行以本仓库 LICENSE（MIT）授权

---

*本项目 README、LICENSE、代码头部注释均保留了上游版权声明与归属，遵守 MIT License 的再分发要求。*