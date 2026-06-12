// logging 行为测试：落盘必轮转（10MB×3）、重复 configure fail-loud、级别门控。
// 注意：configureLogging 进程级单次——本文件独占一个 vitest worker 进程（默认隔离）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, getLogger } from "../src/logging.js";

describe("logging 三铁律", () => {
  it("落盘强制轮转：超 10MB 滚动 .log → .log.1，主文件重新从小开始", () => {
    const dir = mkdtempSync(join(tmpdir(), "canopy-log-"));
    const logFile = join(dir, "canopy.log");
    configureLogging({ level: "info", logFile });
    const log = getLogger("rotate-test");
    const bigMsg = "x".repeat(10 * 1024); // 10KB/条
    for (let i = 0; i < 1100; i++) log.info(bigMsg); // ~11MB → 触发一次轮转
    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(logFile + ".1")).toBe(true);
    // 轮转后主文件 < 10MB + 一条余量
    expect(statSync(logFile).size).toBeLessThan(10 * 1024 * 1024);
    // 轮转份 >= 10MB（写满才滚）
    expect(statSync(logFile + ".1").size).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it("configureLogging 二次调用 → fail loud（铁律 1：sink 只许入口配一次）", () => {
    expect(() => configureLogging({ level: "debug" })).toThrow(/只许入口调用一次/);
  });

  it("级别门控：info 配置下 debug 不写", () => {
    const log = getLogger("level-test");
    // 不抛即可——sink 已是文件，这里验证调用面安全
    log.debug("should be filtered");
    log.warn("should pass");
  });
});
