import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleCommentBulk } from "../../src/api/handlers/comments.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * The bulk moderation endpoint accepts up to 100 ids. With `status` and
 * `updated_at` also bound, a single UPDATE needs 102 parameters, over D1's 100.
 */
const COMMENT_COUNT = 100;

let db: Kysely<Database>;
let comments: CommentRepository;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);
	comments = new CommentRepository(db);
});

afterAll(async () => {
	await db.destroy();
});

async function createComments(contentId: string): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < COMMENT_COUNT; i++) {
		const comment = await comments.create({
			collection: "posts",
			contentId,
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: `Comment ${i}`,
		});
		ids.push(comment.id);
	}
	return ids;
}

async function countWithStatus(contentId: string, status: string): Promise<number> {
	const row = await db
		.selectFrom("_emdash_comments")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("content_id", "=", contentId)
		.where("status", "=", status)
		.executeTakeFirstOrThrow();
	return Number(row.count);
}

describe("comment bulk status on D1", () => {
	it("updates the status of the maximum number of ids the API accepts", async () => {
		const ids = await createComments("repo-entry");

		const updated = await comments.bulkUpdateStatus(ids, "approved");

		expect(updated).toBe(COMMENT_COUNT);
		expect(await countWithStatus("repo-entry", "approved")).toBe(COMMENT_COUNT);
	});

	it("counts each comment once when an id is repeated", async () => {
		const ids = await createComments("repeated-entry");

		const updated = await comments.bulkUpdateStatus([...ids, ids[0]!], "spam");

		expect(updated).toBe(COMMENT_COUNT);
		expect(await countWithStatus("repeated-entry", "spam")).toBe(COMMENT_COUNT);
	});

	it("approves a full bulk request through the handler", async () => {
		const ids = await createComments("handler-entry");

		const result = await handleCommentBulk(db, ids, "approve");

		expect(result).toEqual({ success: true, data: { affected: COMMENT_COUNT } });
		expect(await countWithStatus("handler-entry", "approved")).toBe(COMMENT_COUNT);
	});
});
