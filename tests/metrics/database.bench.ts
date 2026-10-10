import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomKind, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { assertRoomAccess } from "../../lib/rooms";
import { add, measure, requiredFixture, warmup, type Context } from "./common";

export async function seed(context: Context) {
  const users = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(), email: context.runId + "-" + index + "@metrics.invalid",
    username: context.runId + "-" + index, name: "Metrics fixture " + index,
    password: "unusable-metrics-password"
  }));
  const roomIds = Array.from({ length: context.fixtureRows }, () => randomUUID());
  const closedRoomId = randomUUID();
  const userIds = users.map((user) => user.id);
  context.prisma = prisma;
  // Register IDs before any write so a partially failed seed can also be cleaned.
  context.fixture = {
    owner: users[0], member: users[1], outsider: users[2], roomIds,
    closedRoomId, missingRoomId: randomUUID()
  };
  context.registerFixture?.(context.fixture);
  await prisma.user.createMany({ data: users });
  for (let start = 0; start < roomIds.length; start += 500) {
    const ids = roomIds.slice(start, start + 500);
    await prisma.room.createMany({ data: ids.map((id) => ({
      id, roomOwnerId: userIds[0], name: "metrics:" + context.runId, kind: RoomKind.PODCAST
    })) });
    await prisma.video.createMany({ data: ids.map((roomId) => ({ roomId })) });
    await prisma.roomMember.createMany({ data: ids.map((roomId) => ({ roomId, userId: userIds[1] })) });
  }
  await prisma.room.create({ data: {
    id: closedRoomId, roomOwnerId: users[0].id, name: "metrics:closed:" + context.runId,
    kind: RoomKind.PODCAST, closedAt: new Date(), recording: { create: {} }
  } });
  if (!context.metadata.hosted) {
    await prisma.$executeRawUnsafe("ANALYZE rooms");
    await prisma.$executeRawUnsafe("ANALYZE room_members");
    await prisma.$executeRawUnsafe("ANALYZE videos");
  }
  context.metadata.database = { fixtureRooms: roomIds.length + 1, tableRooms: await prisma.room.count(), members: roomIds.length };
}
export async function cleanup(context: Context) {
  if (!context.fixture) return;
  // Cascade removes only this run's owned rooms/recordings/memberships.
  await prisma.user.deleteMany({ where: { id: { in: [
    context.fixture.owner.id, context.fixture.member.id, context.fixture.outsider.id
  ] } } });
}
export async function databaseMetrics(context: Context) {
  const { fixture } = requiredFixture(context);
  const operation = async (index: number) => {
    const roomId = fixture.roomIds[(index * 997) % fixture.roomIds.length];
    const room = await assertRoomAccess(roomId, index % 2 ? fixture.member.id : fixture.owner.id);
    assert.equal(room.id, roomId);
    assert.ok(room.videoId);
  };
  await warmup(context.warmup, () => operation(0));
  const result = await measure(context.samples, operation, context.concurrency);
  // Keep the optimizer's actual choice; do not force index scans.
  const plan = await prisma.$queryRaw(Prisma.sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT r.id, r.room_owner_id FROM rooms r
    WHERE r.id = ${fixture.roomIds[0]}::uuid AND r.closed_at IS NULL
    AND (r.room_owner_id = ${fixture.member.id}::uuid OR EXISTS (
      SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ${fixture.member.id}::uuid
    ))`);
  const { rawMs, ...values } = result;
  add(context, {
    id: "M07", name: "Indexed room authorization lookup", component: "PostgreSQL / Prisma",
    scope: context.metadata.hosted ? "production database, run-owned fixture rows" : "isolated podcazt_metrics database", status: result.errors.length ? "failed" : "passed",
    values: { ...values, fixtureRooms: fixture.roomIds.length + 1, concurrency: context.concurrency, representativeSqlPlan: plan },
    samples: { ormQueryMs: rawMs },
    notes: ["Times the real assertRoomAccess ORM operation including recording lookup, connection pool wait, and DB round trips.",
      "EXPLAIN is separately captured representative SQL, not an exact trace of every Prisma query. Seed and ANALYZE are outside timed samples."]
  });
}
