.PHONY: install frontend build flow flow-prepare flow-clean

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

# 流量监测本地流程：数据采集 → 异常判定 → 校准申请 → 恢复在线 → 归档交接
flow:
	cd frontend && npm run flow:run

flow-prepare:
	cd frontend && npm run flow:prepare

flow-clean:
	cd frontend && npm run flow:clean
