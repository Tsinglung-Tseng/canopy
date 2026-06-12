
# jq 命令使用笔记

## 基础使用

jq 是一个轻量级且灵活的命令行 JSON 处理工具。

### 基本格式化

基本用法：

```bash
jq '.' filename.json
```

从标准输入读取 JSON（例如通过管道）：

```bash
echo '{"name":"John","age":30}' | jq '.'
```

输出：

```json
{
  "name": "John",
  "age": 30
}
```

保存格式化输出到文件：

```bash
jq '.' input.json > output.json
```

### 格式化选项

- 紧凑输出（无格式化）：`jq -c '.' file.json`
- 控制缩进（4个空格）：`jq --indent 4 '.' file.json`
- 带颜色输出（终端默认）：`jq --color-output '.' file.json`
- 无颜色输出：`jq --monochrome-output '.' file.json`

## 过滤器使用

### 身份过滤器

在 `jq '.' input.json > output.json` 命令中，`'.'` 是 jq 的过滤器表达式。

`.` 符号表示"当前对象"或"身份过滤器"。它简单地输出输入的 JSON 数据，不做任何修改或过滤。

### 递归遍历

要查找 JSON 中所有特定字段，可以使用递归下降操作符：

```bash
jq '..|objects|select(has("_type"))|._type' file.json
```

这个命令的详细解释：

1. `..` (递归下降操作符)：
    
    - 递归地遍历 JSON 文档中的每个元素
    - 产生文档中的所有值，包括对象、数组、字符串、数字等
    - 相当于"深度优先搜索"，遍历整个 JSON 树结构
2. `objects`：
    
    - 只保留类型为对象的值
    - 过滤掉所有非对象值（如数组、字符串、数字、布尔值等）
3. `select(has("_type"))`：
    
    - `has("_type")` 函数检查对象是否包含 `_type` 字段
    - `select()` 函数根据条件过滤输入
    - 组合起来，只保留那些包含 `_type` 字段的对象
4. `._type`：
    
    - 从通过前面过滤器的每个对象中提取 `_type` 字段的值

## Python 中的 JSON 格式化

在 Python 中使用 `json.dump()` 进行美观格式化：

```python
import json

with open(data_file_name, 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=4)
```

参数说明：

- `ensure_ascii=False`：保证中文字符能够正确显示，不会被转换为 Unicode 转义序列
- `indent=4`：使用 4 个空格进行缩进

可选的缩进值：

- `indent=2`：使用 2 个空格缩进
- `indent=4`：使用 4 个空格缩进
- `indent='\t'`：使用制表符缩进

## 常见问题

如果遇到语法错误：

```
jq: error: syntax error, unexpected IDENT, expecting $end (Unix shell quoting issues?)
```

可以尝试以下替代语法：

```bash
jq '.. | ._type?' file.json
```

或

```bash
jq '..|._type?' file.json
```

使用 `?` 使字段访问变为可选，这样对于没有该字段的对象不会报错。