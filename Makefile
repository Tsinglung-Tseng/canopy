# Canopy — 基座消费 Makefile（/scaffold 约定）
FSIR_HOME ?= $(HOME)/scaffold/fullStackIR
TSP       := $(FSIR_HOME)/typespec/node_modules/.bin/tsp

GEN_OUT := $(FSIR_HOME)/typespec/tsp-output/fsir-ts/canopy.types.ts
GEN_DST := src/types/canopy.types.ts

.PHONY: ir-gen ir-check ir-golden agents-typecheck agents-test test build

ir-gen: ## .tsp → src/types/canopy.types.ts（生成文件只读）
	cd $(FSIR_HOME)/typespec && $(TSP) compile $(CURDIR)/ir/canopy.tsp \
	  --emit $(FSIR_HOME)/typespec/emitters/ts-obj \
	  --option "fsir-ts.file-name=canopy.types.ts"
	mkdir -p src/types
	cp $(GEN_OUT) $(GEN_DST)

# 生成的 src/types/canopy.types.ts 已落仓；fullStackIR 工具链是维护者侧的回归闸，
# 开源用户无 fsir 时跳过（golden/canopy.types.ts 与落仓文件的 diff 仍然执行）。
ir-check: ## 回归闸：重生成后无漂移（含 golden 对照）；无 fsir 工具链则跳过重生成
	diff -u golden/canopy.types.ts $(GEN_DST)
	@if [ -x "$(TSP)" ]; then \
	  $(MAKE) ir-gen && git diff --exit-code -- $(GEN_DST); \
	else \
	  echo "ir-check: fullStackIR 工具链不存在（$(TSP)），跳过重生成对照（golden diff 已通过）"; \
	fi

ir-golden: ir-gen ## 重钉 golden（仅在 .tsp 变更评审后）
	mkdir -p golden
	cp $(GEN_DST) golden/canopy.types.ts

agents-typecheck: ## tsc --noEmit
	npm run typecheck

agents-test: ## vitest（MockLlm 确定性）
	npm test

test: agents-typecheck agents-test

build:
	npm run build
