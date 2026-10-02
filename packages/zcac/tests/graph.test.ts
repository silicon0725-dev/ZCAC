/**
 * ZCAC-0002 — Task Graph 单元测试(规范 §31 五例 + 运行时变异)。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskGraph, GraphCycleError } from "../src/domain/graph/task-graph.js";
import { createTask } from "../src/domain/task/task.js";

function makeTask(id: string, dependencies: string[] = [], runId = "run_g"): ReturnType<typeof createTask> {
  const task = createTask(
    { id, runId, kind: "custom", input: { prompt: id }, dependencies },
    1_000,
  );
  return task;
}

describe("graph readiness (spec §31)", () => {
  it("Test 1 — single task becomes ready", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    const changes = graph.recomputeReadiness();
    assert.deepEqual(changes.map((c) => [c.task.id, c.to]), [["A", "ready"]]);
    assert.deepEqual(graph.getReadyTasks(), ["A"]);
  });

  it("Test 2 — linear chain A → B → C unblocks stepwise", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("C", ["B"]));
    graph.addTask(makeTask("B", ["A"]));
    graph.addTask(makeTask("A"));
    graph.recomputeReadiness();
    assert.equal(graph.getTask("A")?.status, "ready");
    assert.equal(graph.getTask("B")?.status, "blocked");
    assert.equal(graph.getTask("C")?.status, "blocked");

    graph.updateTask({ ...graph.getTask("A")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("B")?.status, "ready");
    assert.equal(graph.getTask("C")?.status, "blocked");

    graph.updateTask({ ...graph.getTask("B")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("C")?.status, "ready");
  });

  it("Test 3 — fan-out A → B,C,D", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    graph.addTask(makeTask("B", ["A"]));
    graph.addTask(makeTask("C", ["A"]));
    graph.addTask(makeTask("D", ["A"]));
    graph.recomputeReadiness();
    assert.deepEqual(graph.getReadyTasks(), ["A"]);

    graph.updateTask({ ...graph.getTask("A")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.deepEqual(new Set(graph.getReadyTasks()), new Set(["B", "C", "D"]));
  });

  it("Test 4 — fan-in A,B → D needs both", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    graph.addTask(makeTask("B"));
    graph.addTask(makeTask("D", ["A", "B"]));
    graph.recomputeReadiness();

    graph.updateTask({ ...graph.getTask("A")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("D")?.status, "blocked");

    graph.updateTask({ ...graph.getTask("B")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("D")?.status, "ready");
  });

  it("Test 5 — cycle is rejected and graph stays unchanged", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    graph.addTask(makeTask("B"));
    graph.addTask(makeTask("C", ["A"]));
    graph.addDependency("C", "A"); // C depends on A
    graph.addDependency("A", "B");
    assert.throws(() => graph.addDependency("B", "C"), GraphCycleError);
    // 非法边未写入
    assert.deepEqual(graph.getDependencies("B"), []);
    const validation = graph.validate();
    assert.equal(validation.ok, true);
  });

  it("self dependency and unknown tasks are rejected", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    assert.throws(() => graph.addDependency("A", "A"), GraphCycleError);
    assert.throws(() => graph.addDependency("A", "missing"));
    assert.throws(() => graph.addDependency("missing", "A"));
  });

  it("failed dependency blocks dependent (Phase 1 default)", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    graph.addTask(makeTask("B", ["A"]));
    graph.recomputeReadiness();
    graph.updateTask({ ...graph.getTask("A")!, status: "failed" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("B")?.status, "blocked");
  });
});

describe("runtime mutation (spec §14)", () => {
  it("supports adding a task and edges after initial readiness", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A"));
    graph.recomputeReadiness();
    assert.deepEqual(graph.getReadyTasks(), ["A"]);

    // 运行期间:加入 D,依赖 A;再加入 E,依赖 D
    graph.addTask(makeTask("D", ["A"]));
    graph.addTask(makeTask("E", ["D"]));
    graph.recomputeReadiness();
    assert.equal(graph.getTask("D")?.status, "blocked");
    assert.equal(graph.getTask("E")?.status, "blocked");

    graph.updateTask({ ...graph.getTask("A")!, status: "succeeded" });
    graph.recomputeReadiness();
    assert.equal(graph.getTask("D")?.status, "ready");
    assert.equal(graph.getTask("E")?.status, "blocked");
    assert.deepEqual(graph.getDependents("A"), ["D"]);
  });

  it("ready order is priority DESC then createdAt ASC", () => {
    const graph = new TaskGraph();
    const low = makeTask("low");
    low.priority = 1;
    const high = makeTask("high");
    high.priority = 9;
    const mid = makeTask("mid");
    mid.priority = 5;
    // createdAt 相同 → priority 决定;同 priority → id/createdAt FIFO
    graph.addTask(low);
    graph.addTask(mid);
    graph.addTask(high);
    const alsoHigh = makeTask("also-high");
    alsoHigh.priority = 9;
    alsoHigh.createdAt = 2_000;
    graph.addTask(alsoHigh);
    graph.recomputeReadiness();
    assert.deepEqual(graph.getReadyTasks(), ["high", "also-high", "mid", "low"]);
  });

  it("validate flags dangling dependencies", () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask("A", ["ghost"]));
    const result = graph.validate();
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "missing_dependency"));
  });
});
