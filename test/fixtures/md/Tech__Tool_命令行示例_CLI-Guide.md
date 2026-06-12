# 命令行工具示例指南

虚构 CLI 指南，文件名模拟「目录__子目录_笔记」规范名形态。

## 安装

```bash
# 安装
npm install -g example-cli
example-cli index --corpus demo
```

## 子命令

### index

建立索引，重复执行按 md5 跳过未变更源。

### search

两阶段检索：BM25 召回后由 LLM 选节点。

## 退出码

0 成功（含零命中）；1 运行错误；2 用法错误。
