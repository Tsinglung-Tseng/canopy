---
auto_summary: 在macOS下使用Python开发时，用户面临系统级脚本运行、多项目多环境需求及PEP 668规范禁止直接安装到系统Python的约束。uv提供了完整的解决方案：全局工具一律使用`uv
  tool install`（如`uv tool install pipreqs`），每个工具拥有独立虚拟环境，互不干扰且完全合规；新项目从`uv init`开始，配合`uv
  venv`创建`.venv`目录，用`uv add`添加生产依赖、`uv add --dev`添加开发依赖；对于同一项目的dev/staging/prod多环境，优先采用dependency
  groups（PEP 735），在`pyproject.toml`中定义`[dependency-groups]`，通过`uv sync --group dev`等命令快速切换；旧项目可先用`pipreqs`智能生成精简的`requirements.txt`，再执行`uv
  init`、`uv venv`、`uv add -r requirements.txt`完成迁移，并自动生成`uv.lock`锁定精确版本。核心命令包括`uv
  sync`同步依赖、`uv run`在虚拟环境中执行脚本、`uv pip list`查看包列表。最佳实践强调：全局工具禁用`--system`、新项目从`uv
  init`起步、多环境优先用dependency groups（除非需要不同Python版本）、提交`pyproject.toml`和`uv.lock`到Git而忽略`.venv`、团队统一使用`uv
  sync`。常见问题中，遇到Python版本不匹配（如项目要求>=3.13但环境为3.10）可通过`uv venv --python 3.13`指定版本或调整`pyproject.toml`中的`requires-python`字段解决。相关资源包括uv官方文档、PEP
  668、PEP 735及pipreqs。
auto_summary_indexed_at: '2026-06-09'
categories:
- Python开发
- 工具配置
created: 2025-10-12
date: 2025-10-12
problem: macOS下需要系统级Python工具和多项目多环境管理
related-notes:
- '[[Dev_12-Factor-App_云原生应用方法论]]'
related_concepts:
- PEP 668
- PEP 735
- 虚拟环境
- 依赖管理
scenarios:
- 全局工具安装
- 新项目初始化
- 多环境切换
- 旧项目迁移
solution: uv tool + dependency groups
source: 实践经验总结
status: 已解决
tags:
- CONCEPT_.venv
- CONCEPT_package-lock.json
- CONCEPT_uv.lock
- FRAMEWORK_Python
- FRAMEWORK_langchain-openai
- FRAMEWORK_pyproject.toml
- LAW_PEP_668
- LAW_PEP_735
- PLACE_macOS
- PRODUCT_GitHub_Actions
- TOOL_Git
- TOOL_Makefile
- TOOL_black
- TOOL_pipreqs
- TOOL_poetry
- TOOL_uv
title: uv管理Python环境完整指南
type: 技术方案
---

# uv管理Python环境完整指南

## 问题背景

在macOS下使用Python开发时面临的核心需求：

1. **系统级需求**：需要经常运行Python脚本，需要一个默认的系统Python环境和全局工具（如pipreqs）
2. **项目级需求**：有多个独立Python项目，每个项目需要dev、staging、production等不同环境
3. **规范约束**：直接安装到系统Python会违反PEP 668规范

**遇到的具体错误**：

```bash
uv pip install pipreqs
# error: No virtual environment found; run `uv venv` to create an environment, 
# or pass `--system` to install into a non-virtual environment
```

## 速查决策树

### 场景1：我要安装全局工具

```
需要全局使用的工具（pipreqs、black、poetry等）
    ↓
使用 uv tool install
    ↓
✅ uv tool install pipreqs
✅ pipreqs /path/to/project
```

**为什么不用 `--system`**：

- uv tool 会为每个工具创建独立虚拟环境
- 完全遵守PEP 668规范
- 工具之间互不干扰，易于版本管理

---

### 场景2：我要创建新项目

```
新建Python项目
    ↓
初始化 + 创建虚拟环境
    ↓
✅ cd my-project
✅ uv init
✅ uv venv
✅ uv add requests pandas
✅ uv add --dev pytest black
```

**关键点**：

- `uv init` 创建 pyproject.toml
- `uv venv` 自动创建 .venv 目录
- 基础依赖用 `uv add`，开发依赖用 `uv add --dev`

---

### 场景3：我要在项目里切换dev/staging/prod环境

```
一个项目需要多套环境配置
    ↓
使用 dependency groups（推荐）
    ↓
在 pyproject.toml 中定义
    ↓
✅ uv sync --group dev      # 开发环境
✅ uv sync --group staging  # 预发环境  
✅ uv sync                  # 生产环境
```

**配置示例**：

```toml
[project]
dependencies = ["fastapi>=0.104.0"]

[dependency-groups]
dev = ["pytest>=7.0.0", "black>=23.0.0"]
staging = ["locust>=2.0.0"]
prod = ["gunicorn>=21.0.0"]
```

---

### 场景4：我有旧项目的requirements.txt要迁移

```
已有项目使用 requirements.txt
    ↓
生成 requirements.txt（如果没有）
    ↓
✅ pipreqs . --force
    ↓
迁移到 uv 系统
    ↓
✅ uv init
✅ uv venv
✅ uv add -r requirements.txt
✅ uv add --dev -r requirements-dev.txt
```

**验证迁移**：

```bash
uv sync
uv run python -c "import django; print(django.__version__)"
```

---

## 详细方案

### 1. uv tool 作为默认系统环境

**核心概念**：用 `uv tool` 管理全局工具，而非直接安装到系统Python。

#### 安装全局工具

```bash
# 安装工具
uv tool install pipreqs
uv tool install poetry
uv tool install black

# 直接使用（无需激活环境）
pipreqs /path/to/project
black myfile.py
```

#### 管理工具

```bash
# 查看已安装工具
uv tool list

# 升级工具
uv tool upgrade pipreqs

# 卸载工具
uv tool uninstall pipreqs
```

#### 优势

- ✅ 每个工具独立虚拟环境，互不干扰
- ✅ 完全遵守PEP 668规范
- ✅ 版本管理清晰
- ✅ 无需手动激活环境

---

### 2. 不同项目分别管理环境

**核心概念**：每个项目有自己的 `.venv` 目录和 `pyproject.toml` 配置。

#### 项目初始化流程

```bash
# 1. 创建并进入项目目录
mkdir my-api && cd my-api

# 2. 初始化 uv 项目（生成 pyproject.toml）
uv init

# 3. 创建虚拟环境（生成 .venv）
uv venv

# 4. 添加生产依赖
uv add fastapi sqlalchemy pydantic

# 5. 添加开发依赖
uv add --dev pytest black ruff ipython

# 6. 运行项目
uv run python main.py
uv run pytest
```

#### 项目结构

```
my-api/
├── .venv/              # 虚拟环境（自动生成）
├── pyproject.toml      # 项目配置和依赖
├── uv.lock            # 锁文件（自动生成）
├── main.py
└── tests/
```

#### 关键命令

```bash
# 同步依赖（类似 npm install）
uv sync

# 查看已安装包
uv pip list

# 查看包详情
uv pip show fastapi

# 检查依赖冲突
uv pip check
```

---

### 3. 一个项目下管理/切换不同环境

**核心概念**：使用 **dependency groups**（PEP 735），在一个项目内定义多套环境配置。

#### 配置 pyproject.toml

```toml
[project]
name = "my-api"
version = "0.1.0"
# 所有环境的基础依赖
dependencies = [
    "fastapi>=0.104.0",
    "sqlalchemy>=2.0.0",
    "pydantic>=2.0.0",
    "python-dotenv>=1.0.0",
]

# 定义不同环境的额外依赖
[dependency-groups]
dev = [
    "pytest>=7.0.0",
    "pytest-asyncio>=0.21.0",
    "black>=23.0.0",
    "ruff>=0.1.0",
    "ipython>=8.0.0",
    "httpx>=0.25.0",  # 用于测试
]

staging = [
    "pytest>=7.0.0",
    "locust>=2.0.0",  # 性能测试
    "uvicorn>=0.24.0",
]

prod = [
    "gunicorn>=21.0.0",
    "uvicorn[standard]>=0.24.0",
]
```

#### 环境切换命令

```bash
# 切换到开发环境（基础依赖 + dev组）
uv sync --group dev

# 切换到预发环境（基础依赖 + staging组）
uv sync --group staging

# 切换到生产环境（仅基础依赖）
uv sync

# 同时安装多个组
uv sync --group dev --group staging
```

#### 实际工作流

```bash
# 开发阶段
uv sync --group dev
uv run uvicorn main:app --reload
uv run pytest
uv run black .

# 预发测试
uv sync --group staging
uv run locust -f locustfile.py

# 生产部署
uv sync  # 仅生产依赖
uv run gunicorn main:app -w 4
```

#### 使用 Makefile 简化操作

```makefile
.PHONY: dev staging prod test

dev:
	uv sync --group dev
	@echo "✅ Dev environment ready"

staging:
	uv sync --group staging
	@echo "✅ Staging environment ready"

prod:
	uv sync
	@echo "✅ Production environment ready"

test:
	uv run pytest

run-dev:
	uv run uvicorn main:app --reload

run-prod:
	uv run gunicorn main:app -w 4
```

使用：

```bash
make dev      # 切换开发环境
make staging  # 切换预发环境
make prod     # 切换生产环境
make run-dev  # 启动开发服务器
```

---

### 4. 使用pipreqs导出requirements.txt并迁移到uv

**核心概念**：用 `pipreqs` 智能识别项目依赖，然后迁移到uv的现代化管理。

#### 第一步：安装pipreqs

```bash
# 使用 uv tool 安装（推荐）
uv tool install pipreqs
```

#### 第二步：生成requirements.txt

```bash
# 扫描当前项目，生成 requirements.txt
pipreqs . --force

# 检查生成的文件
cat requirements.txt
```

**pipreqs优势**：

- 只包含项目实际使用的包
- 比 `pip freeze` 更精准（不包含无关依赖）

#### 第三步：迁移到uv系统

**方案A：完整迁移（推荐）**

```bash
# 1. 初始化 uv 项目
uv init

# 2. 创建虚拟环境
uv venv

# 3. 从 requirements.txt 批量添加
uv add -r requirements.txt

# 4. 如果有开发依赖
uv add --dev -r requirements-dev.txt

# 5. 验证迁移
uv sync
uv run python -c "import django; print(django.__version__)"

# 6. 清理旧文件（可选）
# rm requirements.txt requirements-dev.txt
```

**方案B：保留requirements.txt**

```bash
# 仅安装，不修改 pyproject.toml
uv pip install -r requirements.txt

# 适用于临时项目或CI/CD环境
```

#### 第四步：生成锁文件

```bash
# uv 会自动生成 uv.lock 文件
# 类似于 package-lock.json 或 Cargo.lock
# 确保团队成员使用完全一致的依赖版本
```

#### 完整迁移示例

假设旧项目结构：

```
old-project/
├── requirements.txt
├── requirements-dev.txt
└── app.py
```

迁移步骤：

```bash
# 1. 进入项目
cd old-project

# 2. 如果没有 requirements.txt，先生成
pipreqs . --force

# 3. 初始化 uv
uv init
uv venv

# 4. 迁移依赖
uv add -r requirements.txt
uv add --dev -r requirements-dev.txt

# 5. 同步并测试
uv sync
uv run python app.py

# 6. 验证所有功能正常后
# 可选：删除旧文件
# rm requirements*.txt
```

迁移后的项目结构：

```
old-project/
├── .venv/              # 新增
├── pyproject.toml      # 新增
├── uv.lock            # 新增
├── app.py
└── requirements.txt    # 可选保留
```

---

## 常见问题FAQ

### Q1: 为什么不直接用 `uv pip install --system`？

**A**:

- 违反PEP 668规范（破坏系统包管理）
- 全局工具会互相干扰
- 难以管理版本和升级
- `uv tool` 提供了更好的替代方案

### Q2: 如何查看当前使用的是哪个环境？

**A**:

```bash
# 查看虚拟环境路径
which python

# 查看已安装的包（当前环境）
uv pip list

# 查看 dependency groups 状态
cat uv.lock  # 锁文件记录了安装的组
```

### Q3: dependency groups vs 多个虚拟环境，如何选择？

**A**:

- **dependency groups**（推荐）：同一项目不同配置，切换快速
- **多虚拟环境**：需要同时运行多个环境，或Python版本不同

### Q4: 已有项目从pip迁移到uv，会破坏原有环境吗？

**A**: 不会

```bash
# uv 创建新的 .venv，不影响系统 Python
# 如果不满意，直接删除 .venv 和 pyproject.toml 即可回退
rm -rf .venv pyproject.toml uv.lock
```

### Q5: CI/CD 中如何使用uv？

**A**:

```bash
# GitHub Actions 示例
- name: Install uv
  run: curl -LsSf https://astral.sh/uv/install.sh | sh

- name: Install dependencies
  run: uv sync

- name: Run tests
  run: uv run pytest
```

### Q6: uv 生成的 uv.lock 文件有什么用？

**A**:

- 锁定所有依赖的精确版本（包括传递依赖）
- 确保团队成员环境一致
- 类似 npm 的 package-lock.json
- 应该提交到 Git

### Q7: 如何在不同 Python 版本间切换？

**A**:

```bash
# 创建指定 Python 版本的虚拟环境
uv venv --python 3.11 .venv-py311
uv venv --python 3.12 .venv-py312

# 激活对应环境
source .venv-py311/bin/activate
```

---

请在笔记的 **「常见问题 FAQ」部分下方（即 Q7 后）** 添加以下新的小节内容：

---

### **Q8: 项目初始化时报错 “incompatible with the project’s Python requirement”**
**现象**：

```
uv add langchain-openai
# error: The Python request from `.python-version` resolved to Python 3.10.16,
# which is incompatible with the project's Python requirement: `>=3.13`
```

**原因**：

项目的 pyproject.toml 要求 Python >=3.13，但 .python-version 或系统环境是 3.10。

**解决方案一（推荐，升级至 3.13）**：
```
uv python install 3.13
uv python pin 3.13
uv sync
```

**解决方案二（修改项目要求）**：
编辑 pyproject.toml：

```
[project]
requires-python = ">=3.10"
```

然后执行：

```
uv sync
```

**检查当前版本**：

```
uv python list
cat .python-version
```

**最佳实践**：

为每个项目固定 Python 版本：

```
uv python pin $(uv python find 3.13)
```

---
## 核心命令速查

### 全局工具管理

```bash
uv tool install <tool>    # 安装全局工具
uv tool list              # 列出已安装工具
uv tool upgrade <tool>    # 升级工具
uv tool uninstall <tool>  # 卸载工具
```

### 项目初始化

```bash
uv init                   # 初始化项目
uv venv                   # 创建虚拟环境
uv add <package>          # 添加依赖
uv add --dev <package>    # 添加开发依赖
uv sync                   # 同步依赖
```

### 环境切换

```bash
uv sync --group dev       # 切换到开发环境
uv sync --group staging   # 切换到预发环境
uv sync                   # 切换到生产环境
```

### 环境检查

```bash
uv pip list               # 列出已安装包
uv pip show <package>     # 查看包详情
uv pip check              # 检查依赖冲突
uv pip freeze             # 导出依赖列表
```

### 运行命令

```bash
uv run python script.py   # 在虚拟环境中运行脚本
uv run pytest             # 运行测试
uv run black .            # 运行代码格式化
```

---

## 最佳实践总结

1. **全局工具**：一律使用 `uv tool install`，不要用 `--system`
2. **新项目**：从 `uv init` 开始，不要手动创建 pyproject.toml
3. **多环境**：优先使用 dependency groups，除非需要不同Python版本
4. **旧项目迁移**：先用 `pipreqs` 生成精简的 requirements.txt，再迁移
5. **版本控制**：提交 `pyproject.toml` 和 `uv.lock`，不提交 `.venv/`
6. **团队协作**：确保所有成员使用 `uv sync` 而非手动安装

---

## 相关资源

- [uv 官方文档](https://docs.astral.sh/uv/)
- [PEP 668: 标记 Python 环境为"外部管理"](https://peps.python.org/pep-0668/)
- [PEP 735: Dependency Groups](https://peps.python.org/pep-0735/)
- [pipreqs GitHub](https://github.com/bndr/pipreqs)
## 🔗 相关笔记

- [[DevOps_ModelScope-SOCKS-Proxy-Error_uv-tool-inject修复]]