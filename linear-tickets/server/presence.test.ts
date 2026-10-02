import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { needsOwner, Presence } from "./presence";

// Host-local times, like the schedule.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 0, day, hours, minutes).getTime();

async function presence(t: TestContext, start: number) {
  const directory = await mkdtemp(join(tmpdir(), "presence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = start;
  const path = join(directory, "presence.json");
  return { instance: new Presence(path, () => now), reopen: () => new Presence(path, () => now), set: (time: number) => { now = time; } };
}

test("the away window runs over midnight; without a schedule the owner is present", async (t) => {
  const p = await presence(t, at(5, 21, 59));
  assert.equal(await p.instance.away(), false);
  await p.instance.update({ schedule: { enabled: true, awayFrom: "22:00", awayUntil: "07:00" } });
  assert.deepEqual(await p.instance.state(), { away: false, source: "schedule", until: new Date(at(5, 22)).toISOString(), schedule: { enabled: true, awayFrom: "22:00", awayUntil: "07:00" } });
  p.set(at(5, 22));
  assert.equal(await p.instance.away(), true);
  p.set(at(6, 6, 59));
  assert.equal(await p.instance.away(), true);
  p.set(at(6, 7));
  assert.equal(await p.instance.away(), false);
});

test("the toggle holds until the schedule's next switch, or until toggled again without a schedule; it survives a restart", async (t) => {
  const p = await presence(t, at(5, 23));
  await p.instance.update({ schedule: { enabled: true, awayFrom: "22:00", awayUntil: "07:00" } });
  const present = await p.instance.update({ away: false });
  assert.deepEqual({ away: present.away, source: present.source, until: present.until }, { away: false, source: "manual", until: new Date(at(6, 7)).toISOString() });
  p.set(at(6, 6));
  assert.equal(await p.reopen().away(), false, "still the toggle after a reload");
  p.set(at(6, 7));
  assert.equal(await p.instance.away(), false, "the schedule's day");
  p.set(at(6, 22, 30));
  assert.equal(await p.instance.away(), true, "and its next night");

  await p.instance.update({ away: true });
  assert.equal((await p.instance.update({ schedule: { enabled: false, awayFrom: "22:00", awayUntil: "07:00" } })).away, false, "a new schedule drops the toggle");
  await p.instance.update({ away: true });
  p.set(at(20, 12));
  assert.deepEqual({ away: (await p.instance.state()).away, until: (await p.instance.state()).until }, { away: true, until: null });
  await assert.rejects(p.instance.update({ schedule: { enabled: true, awayFrom: "08:00", awayUntil: "08:00" } }), /different start and end/);
});

test("a ticket needs the owner when marked attended or when its plan needs approval; a planner or an approved plan never", () => {
  assert.equal(needsOwner([], false, "paseo"), false);
  assert.equal(needsOwner(["Paseo-Attended"], false, "paseo"), true);
  assert.equal(needsOwner([], true, "paseo"), true, "written by someone else");
  assert.equal(needsOwner(["plan"], false, "paseo"), true);
  assert.equal(needsOwner(["plan", "plan-ready"], false, "paseo"), false, "its plan is approved");
  assert.equal(needsOwner(["paseo-planner", "plan"], false, "paseo"), false, "the owner asked for the planner");
});
