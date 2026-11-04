// The ends of runs and the rules file's worst moments. Failure cases: cancelling a run leaves its "will retry" or
// "unknown" card open with words that have stopped being true; a run gone unknown with its worker gone for good has no
// way to be ended by the owner; a third failure that brought its own notice is the last anyone ever hears of it; the
// rules file disappearing for a moment (an editor's atomic save) crashes the hub instead of waiting for it to come
// back; a notice and a later ask with the same words in one thread swallow the question.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("lifecycle");
const { ingest, claimNext, finish, sweep, cancel, heartbeat, reloadRules, tick, getView } =
  await import("../host/runtime.ts");
const { all, one, run } = await import("./storage.ts");
const { AuthError } = await import("../kernel/errors.ts");

const note = (n: number, step = "new") => ({
  id: `feedback:${n}:${step}`,
  type: `feedback.${step}`,
  subject: `#${n}`,
  summary: `第 ${n} 条`,
  link: `https://x.test/feedback?id=${n}`,
});
const alert = (key: string) => ({ id: `alert:${key}`, type: "alert.raised", subject: key });
const told = () =>
  all<{ id: number; key: string; title: string; text: string; state: string }>(
    "SELECT id, key, title, text, state FROM cards ORDER BY id",
  );
// The due table lives only in the projection, with no SQL view over it.
const dueRows = () =>
  all<{ data: { kind: string; key: string } }>("SELECT data FROM projections WHERE collection = 'due'");
const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const state = (id: number) => one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [id])!.state;
const card = (id: number) =>
  one<{ key: string; state: string; result: string }>("SELECT key, state, result FROM cards WHERE id = ?", [id]);

test("cancelling a run closes its failing card, and its unknown card too", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  for (let i = 0; i < 3; i++) {
    finish(job.run, job.token, { outcome: "failed", error: "卡住了" }, at(i + 1));
    if (i < 2) job = claim("w1", at(10 * (i + 1)))!;
  }
  const failing = told().find((c) => c.key === `run:${job.run}:failing`)!;
  assert.ok(failing, "three failures in a row are told once");
  // The run waits to be handed out again; the owner calls it off instead.
  cancel(job.run, at(31));
  assert.equal(state(job.run), "cancelled");
  const closed = card(failing.id)!;
  assert.equal(closed.state, "closed", "cancelling closes the card that promised a retry");
  assert.equal(closed.result, "已取消");

  clean();
  ingest("ops", alert("probe.public"), at(0));
  const going = claim("w2", at(0))!;
  heartbeat("w2", [going.run], at(3));
  heartbeat("w2", [], at(9));
  sweep(at(9));
  const unknown = told().find((c) => c.key === `run:${going.run}:unknown`)!;
  assert.ok(unknown, "the run gone quiet is told");
  cancel(going.run, at(10));
  assert.equal(card(unknown.id)!.state, "closed", "calling it off closes the unknown card");
  // The worker's late word that it stopped can't change what the owner already ended.
  assert.throws(() => finish(going.run, going.token, { outcome: "cancelled" }, at(11)), AuthError);
});

test("a run that failed three times, went out again and went quiet is fully closed by one cancel", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  for (let i = 0; i < 3; i++) {
    finish(job.run, job.token, { outcome: "failed", error: "卡住了" }, at(i + 1));
    job = claim("w1", at(10 * (i + 1)))!;
  }
  const failing = told().find((c) => c.key === `run:${job.run}:failing`)!;
  assert.ok(failing, "three failures in a row are told once");
  // Taken again, then its worker goes quiet mid-run: both cards are open at once.
  heartbeat("w1", [job.run], at(33));
  heartbeat("w1", [], at(39));
  sweep(at(39));
  const unknown = told().find((c) => c.key === `run:${job.run}:unknown`)!;
  assert.ok(unknown, "the run gone quiet is told");
  assert.equal(card(failing.id)!.state, "open");
  cancel(job.run, at(40));
  assert.equal(card(failing.id)!.state, "closed", "the promise of a retry ends with the run");
  assert.equal(card(failing.id)!.result, "已取消");
  assert.equal(card(unknown.id)!.state, "closed");
});

test("a run gone unknown with nobody coming back for it can be ended by the owner", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const going = claim("w2", at(0))!;
  heartbeat("w2", [going.run], at(3));
  heartbeat("w2", [], at(9));
  sweep(at(9));
  assert.equal(state(going.run), "unknown");
  cancel(going.run, at(10));
  assert.equal(state(going.run), "cancelled");
  const open = told().filter((c) => c.state === "open");
  assert.deepEqual(
    open.map((c) => c.key),
    [],
    "nothing is left asking about a run the owner has called off",
  );
  // The owner called it off: the token died with the decision, so a late result is refused at the door.
  assert.throws(() => finish(going.run, going.token, { outcome: "done", summary: "其实修好了" }, at(12)), AuthError);
});

test("a third failure that brought its own notice still leaves the failing card behind", () => {
  clean();
  ingest("app", note(1), at(0));
  let job = claim("w1", at(0))!;
  for (let i = 0; i < 3; i++) {
    finish(
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "要批准",
        notice: [{ title: "要你批准", text: "确认权限" }],
      },
      at(i + 1),
    );
    job = claim("w1", at(10 * (i + 1)))!;
  }
  const failing = told().find((c) => c.key === `run:${job.run}:failing`);
  assert.ok(failing, "the owner is told it keeps failing, even when the failure brought a notice");
});

test("the rules file gone for a moment is waited out, not a crash, and it comes back with its change", () => {
  const file = join(home, "rules.json");
  const good = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
  writeFileSync(file, JSON.stringify(good));
  reloadRules(file);
  // An editor's atomic save: the file is gone between one moment and the next.
  rmSync(file);
  const answer = reloadRules(file);
  assert.equal(answer.changed, false);
  assert.match(answer.problem!, /暂时读不到/);
  const before = getView().seq;
  // Through the host's own tick, where the choice to stay quiet about a missing file is made.
  tick(at(0));
  // The only new fact is the tick itself: no "rules.json 写错了" fact, no card.
  assert.equal(getView().seq, before + 1, "a missing file is waited out, not told as a mistake in it");
  const toldOfIt = told().filter((c) => c.key.startsWith("rules:"));
  assert.deepEqual(toldOfIt, [], "no card says the rules are broken when they're only missing");
  assert.ok(existsSync(join(home, "hub.db")), "the hub is still standing");
  const changed = good;
  changed.rules[0].prompt = "改过的说法。";
  writeFileSync(file, JSON.stringify(changed));
  assert.deepEqual(reloadRules(file), { changed: true });
});

test("a worker that never came back and was cancelled leaves no due work behind", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const going = claim("w2", at(0))!;
  heartbeat("w2", [going.run], at(3));
  heartbeat("w2", [], at(9));
  sweep(at(9));
  cancel(going.run, at(10));
  const due = dueRows();
  assert.ok(
    !due.some((row) => row.data.kind === "lease" && row.data.key === String(going.run)),
    "no lease waits on a run called off",
  );
});

test("an ask is not swallowed by an earlier open notice with the same words in one thread", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  const same = { title: "同一句话", text: "一样的内容" };
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "第一轮完成",
      notice: [{ ...same, key: "shared" }],
      ask: [{ ...same, options: ["甲", "乙"], key: "shared" }],
    },
    at(1),
  );
  const opens = told().filter((c) => c.state === "open");
  assert.equal(opens.length, 2, "the notice and the question are two cards, not one");
  assert.ok(
    opens.some((c) => c.key.endsWith(":notice")),
    JSON.stringify(opens),
  );
  assert.ok(
    opens.some((c) => c.key.endsWith(":ask")),
    JSON.stringify(opens),
  );
});

test("an unknown run's late result after the owner ended it doesn't wake its thread", () => {
  clean();
  ingest("ops", alert("probe.public"), at(0));
  const going = claim("w2", at(0))!;
  heartbeat("w2", [going.run], at(3));
  heartbeat("w2", [], at(9));
  sweep(at(9));
  cancel(going.run, at(10));
  const before = getView().seq;
  assert.throws(() => finish(going.run, going.token, { outcome: "done" }, at(12)), AuthError);
  assert.equal(getView().seq, before, "refused changes nothing");
});
