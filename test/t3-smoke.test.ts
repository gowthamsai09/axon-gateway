import { describe, expect, it } from "vitest";
import { at } from "./helpers";
import { makeKit } from "./t3-helpers";

describe("tier 3 smoke", () => {
  it("registers, issues, starts and polls", async () => {
    const k = await makeKit();
    const reg = await k.register();
    expect(reg.status).toBe(200);
    const { token, res } = await k.issue();
    expect(res.status).toBe(201);
    const r = await k.send({ skill: "run_personal_digest", max_items: 5 }, k.bearer(token));
    const body = await r.json();
    expect(at(body, "result.status.state")).toBe("submitted");
    const id = at(body, "result.id") as string;
    const g = await k.rpc("tasks/get", { id }, k.bearer(token));
    expect(at(await g.json(), "result.status.state")).toBe("submitted");
  });
});
