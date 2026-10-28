# 文档

本页是公开文档的唯一导航。各文档只定义其职责范围内的事实；同一事实不在多处重复。

## 使用与开发

- [架构](architecture.md)：组件职责、数据流与边界。
- [构建指南](build-guide.md)：前置、Web/Mod 构建、测试、真实资产与平台限制。
- [Mod 使用说明](../mod/gtnh/README.md)：`/sde` 命令与最短流程。

## 格式契约

- [协议](protocol.md)：运行时 JSON、Plain/Envelope 容器与 proto schema 工具。
- [场景文件格式](contracts/format-scene-file.md)：场景字段、产物形态与捕获语义。
- [多方块文档格式](contracts/format-multiblock-doc.md)：多方块声明、通道、变体与体积约束。
- [部件数据契约](contracts/format-parts-contract.md)：部件、物品索引与编辑往返。

## 内核契约

- [Web 内核契约](contracts/web-kernel-contracts.md)：值类型、编辑入口、错误分类、求值与所有权。
- [Web 内核几何契约](contracts/web-kernel-geometry-contract.md)：坐标、仿射、枢轴与父链语义。

## 控制面

- [控制面契约](control-plane/contract.md)：端点、权限、错误码、动作清单与版本规则。
- [用例文件规范](control-plane/case-file.md)：段、步骤、判据、变体、证据与执行语义。
- [观测记录规范](control-plane/observation-record.md)：`observation.json` 的结构与解释规则。
- [输入手段契约](control-plane/input-contract.md)：`input.*` 参数、生命周期、能力与未实现项。

## 测试与工具

- [测试资产](../test/README.md)：夹具、用例、判据与期望产物的导航。
- [控制面脚本](../scripts/control-plane/README.md)：脚本入口、前置、调用器与静态检查。
- [验收脚本](../scripts/acceptance/README.md)：验收命令、参数、退出码、证据位置与边界。
- [Wiki 素材审计](../scripts/wiki-material-audit/README.md)：用法、判据、输出与退出码。
- [E2E 验收数据](../web/e2e/accept/README.md)：场景/判据数据、真实运行入口与退出条件。
- [多方块 E2E 助手](../web/e2e/helpers/multiblock/README.md)：运行命令、文件索引、观测点与对齐规则。
- [部件 E2E 助手](../web/e2e/helpers/parts/README.md)：运行命令、oracle 与坐标映射。
