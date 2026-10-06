.PHONY: install flow-pipeline frontend build

install:
	cd frontend && npm install

# 流量监测本地流水线：环境检查 -> 样例准备 -> 数据校验 -> 异常判定 -> 校准联动与发布。
# npm run dev / npm run build 已通过 predev/prebuild 钩子自动先跑这条流水线，
# 需要单独重跑（比如修完样例）时用 make flow-pipeline。
flow-pipeline:
	cd frontend && node scripts/flow-pipeline.mjs

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build
