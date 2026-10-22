import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { checkFixture } from "./check-fixture.js";
import { runChecks } from "../src/checks.js";
import { repositorySnapshot } from "../src/repository.js";
import { git } from "./supervisor-fixture.js";
import type { DeliveryInput } from "../src/delivery-contracts.js";
import { randomUUID } from "node:crypto";
export async function deliveryFixture() {
  const f = await checkFixture();
  f.config.capabilities.commit = true;
  f.config.delivery = { branchPrefix: "feature/agent-", recovery: "query_only", commit: { message: "fix: corrección demo", author: { name: "Demo", email: "demo@example.invalid" } } };
  await writeFile(join(f.config.repoRoot, "answer.txt"), "reviewed\n");
  const snapshot = await repositorySnapshot(f.config.repoRoot);
  const context = { ...f.context, snapshot };
  const evidence = await runChecks(f.config, snapshot.head, { ...f, snapshot });
  const review = { ...f.review, repoSha: snapshot.head };
  const input: DeliveryInput = { runId: randomUUID(), task: f.task, context, evidence, review, artifactDir: join(f.dir, "delivery") };
  return { ...f, snapshot, context, evidence, review, input };
}
export async function localOrigin(root: string, dir: string) {
  const remote = join(dir, "origin.git"); await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main"); await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "origin", "HEAD:refs/heads/main"); return remote;
}
