import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeReviewLoop,
  authorizeVerifier,
  createCoreVerifierRegistry,
  createIndependentReviewPacket,
  createProject,
  deriveVerificationProfile,
  enforceReviewLoopGuard,
  evaluateCompletionPolicy,
  listCurrentObjects,
  putObject,
  recordFormalAlignment,
  recordIndependentReview,
  recoverInterruptedVerifications,
  registerArtifactBytes,
  runVerification,
  VerifierRegistry,
  type CompletionPolicy,
  type IndependentReviewPacket,
  type VerifierDefinition,
} from "../src/index.js";

describe("Stage 8 verification plane", () => {
  const sandboxes: string[] = [];

  async function sandbox(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `rw-stage8-${name}-`));
    sandboxes.push(root);
    return join(root, "project");
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function claimFixture(name: string) {
    const root = await sandbox(name);
    const project = await createProject(root, { title: `Stage 8 ${name}` });
    const branchId = project.manifest.defaultBranchId;
    const context = await putObject(root, {
      branchId,
      objectType: "context",
      content: { domain: "integers" },
    });
    const claim = await putObject(root, {
      branchId,
      objectType: "claim",
      content: {
        statement: "p(n) is prime for 0 <= n <= 39",
        contextId: context.objectId,
        authorModelFamily: "author-family",
        modelConfidence: 0.999,
        selfAssessment: "This is certainly correct.",
      },
    });
    return { root, branchId, context, claim };
  }

  it("derives report outcomes and refuses to treat a report adapter as a proof kernel", async () => {
    const registry = createCoreVerifierRegistry();
    expect(registry.list().map((entry) => entry.contract.verifierId)).toEqual([
      "core.artifact-integrity",
      "core.citation-report",
      "core.code-report",
      "core.formal-report",
      "core.numerical-report",
      "core.physical-report",
      "core.symbolic-report",
    ]);
    const controller = new AbortController();
    const result = await registry.execute(
      "core.symbolic-report",
      {
        summary: "A partial symbolic report",
        checks: [
          { checkId: "equivalence", status: "passed", summary: "Expressions agree." },
        ],
      },
      {
        signal: controller.signal,
        projectRoot: "/unused",
        branchId: "br_unused",
        claimRef: { objectId: "clm_unused", versionId: "ver_unused" },
        contextRef: { objectId: "ctx_unused", versionId: "ver_unused" },
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.checks.filter((check) => check.status === "failed").map((check) => check.checkId))
      .toEqual(["counterexamples", "domain-assumptions", "simplification-trace"]);
    expect(registry.get("core.formal-report")?.contract.assurance).toBe("reported");
    expect(() => authorizeVerifier(registry.get("core.code-report")!.contract, {
      allowedVerifierIds: [],
      grantedCapabilities: [],
    })).toThrow("explicit allow-list");
  });

  it("persists exact verifier provenance and enforces a current verification gate", async () => {
    const { root, branchId, context, claim } = await claimFixture("integrity");
    const producer = await putObject(root, {
      branchId,
      objectType: "run",
      content: { kind: "execution", status: "succeeded" },
    });
    const environment = await putObject(root, {
      branchId,
      objectType: "environment",
      content: { kind: "execution-environment", runtime: "test" },
    });
    const artifact = await registerArtifactBytes(root, new TextEncoder().encode("0,41,true\n"), {
      branchId,
      logicalName: "range.csv",
      mediaType: "text/csv",
      producedByRunId: producer.objectId,
      environmentId: environment.objectId,
      reproducibility: "deterministic",
    });
    const recorded = await runVerification(root, createCoreVerifierRegistry(), {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
      verifierId: "core.artifact-integrity",
      input: { artifactIds: [artifact.artifact.artifactId] },
      artifactIds: [artifact.artifact.artifactId],
    });
    expect(recorded.result.outcome).toBe("passed");
    expect(recorded.failure).toBeUndefined();
    expect(recorded.evidence.content).toMatchObject({
      kind: "verification-result",
      dimension: "reproducibility",
      assurance: "machine-checked",
      outcome: "passed",
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      provenance: { producedByRunId: recorded.run.objectId },
    });

    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "reproducible-claim",
      name: "Require reproducible evidence",
      rules: [
        {
          ruleId: "reproduction",
          kind: "verification_gate",
          claimIds: [claim.objectId],
          dimensions: ["reproducibility"],
          requiredStatus: "supported",
        },
      ],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy })).passed).toBe(true);

    await putObject(root, {
      branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: {
        ...(claim.content as Record<string, unknown>),
        statement: "p(n) is prime for 0 <= n <= 40",
      },
    });
    const stale = deriveVerificationProfile(root, {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
    });
    expect(stale.dimensions.find((entry) => entry.dimension === "reproducibility")?.status)
      .toBe("stale");
    expect((await evaluateCompletionPolicy(root, { branchId, policy })).passed).toBe(false);
  });

  it("keeps a complete reported checklist visible but outside hard gates by default", async () => {
    const { root, branchId, context, claim } = await claimFixture("reported");
    const checks = ["equivalence", "domain-assumptions", "simplification-trace", "counterexamples"]
      .map((checkId) => ({ checkId, status: "passed" as const, summary: `${checkId} reported.` }));
    await runVerification(root, createCoreVerifierRegistry(), {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
      verifierId: "core.symbolic-report",
      input: { summary: "Complete external report.", checks },
    });
    expect(deriveVerificationProfile(root, {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
    }).dimensions.find((entry) => entry.dimension === "symbolic")?.status).toBe("supported");
    const baseRule = {
      ruleId: "symbolic",
      kind: "verification_gate" as const,
      claimIds: [claim.objectId],
      dimensions: ["symbolic" as const],
    };
    const defaultPolicy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "machine-symbolic",
      name: "Machine symbolic check",
      rules: [baseRule],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy: defaultPolicy })).passed)
      .toBe(false);
    const reportPolicy: CompletionPolicy = {
      ...defaultPolicy,
      policyId: "reported-symbolic",
      rules: [{ ...baseRule, allowedAssurances: ["reported"] }],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy: reportPolicy })).passed)
      .toBe(true);
  });

  it("builds a fresh-context review packet without persuasive self-assessment", async () => {
    const { root, branchId, context, claim } = await claimFixture("review");
    const evidence = await putObject(root, {
      branchId,
      objectType: "evidence",
      content: { method: "complete enumeration", summary: "All 40 cases checked." },
    });
    await import("../src/project.js").then(({ addEdge }) => addEdge(root, {
      branchId,
      edgeType: "supports",
      fromObjectId: evidence.objectId,
      toObjectId: claim.objectId,
      contextId: context.objectId,
    }));
    const packet = createIndependentReviewPacket(root, {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
    });
    expect(JSON.stringify(packet)).not.toContain("modelConfidence");
    expect(JSON.stringify(packet)).not.toContain("selfAssessment");
    await expect(recordIndependentReview(root, {
      branchId,
      packet,
      reviewer: {
        reviewerId: "same-family",
        kind: "model",
        modelFamily: "author-family",
        freshContext: true,
        adversarial: true,
      },
      summary: "Would otherwise pass.",
      evidenceObjectIds: [evidence.objectId],
    })).rejects.toThrow("different model family");

    const review = await recordIndependentReview(root, {
      branchId,
      packet,
      reviewer: {
        reviewerId: "reviewer-b",
        kind: "model",
        modelFamily: "reviewer-family",
        freshContext: true,
        adversarial: true,
        spotCheckSeed: 7,
        spotCheckedEvidenceObjectIds: [evidence.objectId],
      },
      summary: "The finite statement is supported by the cited enumeration.",
      evidenceObjectIds: [evidence.objectId],
    });
    expect(review.outcome).toBe("passed");
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "independent-review",
      name: "Independent adversarial review",
      rules: [{
        ruleId: "review",
        kind: "independent_review",
        claimIds: [claim.objectId],
        minReviewers: 1,
        requireFreshContext: true,
        requireAdversarial: true,
        requireCrossModelFamily: true,
      }],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy })).passed).toBe(true);
    await putObject(root, {
      branchId,
      objectId: evidence.objectId,
      objectType: "evidence",
      content: { method: "revised enumeration", summary: "The evidence changed." },
    });
    expect((await evaluateCompletionPolicy(root, { branchId, policy })).passed).toBe(false);
  });

  it("detects repeated objections, escalates to a durable gap, and blocks the loop gate", async () => {
    const { root, branchId, context, claim } = await claimFixture("loop");
    const evidence = await putObject(root, {
      branchId,
      objectType: "evidence",
      content: { method: "sample", summary: "A finite sample." },
    });
    const packet: IndependentReviewPacket = createIndependentReviewPacket(root, {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
      evidenceObjectIds: [evidence.objectId],
    });
    for (let index = 0; index < 3; index += 1) {
      await recordIndependentReview(root, {
        branchId,
        packet,
        reviewer: {
          reviewerId: `reviewer-${index}`,
          kind: "model",
          modelFamily: `review-family-${index}`,
          freshContext: true,
          adversarial: true,
        },
        summary: "The finite sample does not prove the universal claim.",
        evidenceObjectIds: [evidence.objectId],
        objections: [{
          objectionId: `scope-${index}`,
          statement: "Finite evidence cannot prove the universal quantifier.",
          status: "open",
        }],
      });
    }
    const analysis = analyzeReviewLoop(root, { branchId, claimId: claim.objectId, contextId: context.objectId });
    expect(analysis.status).toBe("human-required");
    expect(analysis.signals.map((signal) => signal.code)).toContain("repeated-objection");
    const enforced = await enforceReviewLoopGuard(root, {
      branchId,
      claimId: claim.objectId,
      contextId: context.objectId,
    });
    expect(enforced.failure?.content).toMatchObject({
      kind: "verification-review-loop",
      status: "human-required",
    });
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "loop-clear",
      name: "No reviewer death spiral",
      rules: [{
        ruleId: "loop",
        kind: "review_loop_clear",
        claimIds: [claim.objectId],
      }],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy })).passed).toBe(false);
  });

  it("keeps formal kernel verification separate from informal statement alignment", async () => {
    const { root, branchId, context, claim: informal } = await claimFixture("formal");
    const formal = await putObject(root, {
      branchId,
      objectType: "claim",
      content: {
        statement: "theorem finite_range : ∀ n < 40, Nat.Prime (n*n+n+41)",
        contextId: context.objectId,
        language: "lean4",
      },
    });
    const kernel: VerifierDefinition = {
      contract: {
        schemaVersion: 1,
        verifierId: "lean.kernel",
        name: "Lean kernel",
        version: "1.0.0",
        description: "Injected kernel adapter used by the conformance test.",
        dimension: "formal",
        assurance: "formal-kernel",
        inputSchema: { type: "object", additionalProperties: false },
        requiredCapabilities: [],
        sideEffects: ["none"],
        determinism: "deterministic",
        supportsCancellation: false,
        defaultTimeoutMs: 1_000,
      },
      async verify() {
        return {
          summary: "Lean kernel accepted the declaration with no proof holes.",
          checks: [
            { checkId: "kernel-build", status: "passed", summary: "Build passed." },
            { checkId: "proof-holes", status: "passed", summary: "No sorry/admit." },
            { checkId: "axiom-audit", status: "passed", summary: "Only allowed axioms." },
            { checkId: "dependency-graph", status: "passed", summary: "Imports were captured." },
            { checkId: "compiler-output", status: "passed", summary: "Compiler output was retained." },
          ],
          toolVersions: { lean: "4.test" },
        };
      },
    };
    const registry = new VerifierRegistry().register(kernel);
    const proof = await runVerification(root, registry, {
      branchId,
      claimId: formal.objectId,
      contextId: context.objectId,
      verifierId: "lean.kernel",
      input: {},
    });
    expect(deriveVerificationProfile(root, {
      branchId,
      claimId: formal.objectId,
      contextId: context.objectId,
    }).dimensions.find((entry) => entry.dimension === "formal")?.status).toBe("verified");

    const beforeAlignment: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "alignment",
      name: "Informal/formal alignment",
      rules: [{ ruleId: "alignment", kind: "formal_alignment", claimIds: [informal.objectId] }],
    };
    expect((await evaluateCompletionPolicy(root, { branchId, policy: beforeAlignment })).passed).toBe(false);
    await recordFormalAlignment(root, {
      branchId,
      contextId: context.objectId,
      informalClaimId: informal.objectId,
      formalClaimId: formal.objectId,
      formalEvidenceId: proof.evidence.objectId,
      reviewerId: "human-reviewer",
      outcome: "passed",
      summary: "The Lean statement matches the bounded informal claim.",
    });
    expect((await evaluateCompletionPolicy(root, { branchId, policy: beforeAlignment })).passed).toBe(true);
    await putObject(root, {
      branchId,
      objectId: formal.objectId,
      objectType: "claim",
      content: {
        ...(formal.content as Record<string, unknown>),
        statement: "theorem finite_range_revised : ∀ n < 40, Nat.Prime (n*n+n+41)",
      },
    });
    expect((await evaluateCompletionPolicy(root, { branchId, policy: beforeAlignment })).passed).toBe(false);
    expect(listCurrentObjects(root, branchId).filter((object) => object.objectType === "alignment"))
      .toHaveLength(1);
  });

  it("recovers a crash-window verifier run as interrupted evidence instead of losing it", async () => {
    const { root, branchId, context, claim } = await claimFixture("recovery");
    const interrupted = await putObject(root, {
      branchId,
      objectType: "run",
      content: {
        schemaVersion: 1,
        kind: "verification-run",
        status: "running",
        verifier: { verifierId: "external.symbolic" },
        claimRef: { objectId: claim.objectId, versionId: claim.versionId },
        contextRef: { objectId: context.objectId, versionId: context.versionId },
      },
    });
    const recovered = await recoverInterruptedVerifications(root, { branchId });
    expect(recovered.interruptedRunIds).toEqual([interrupted.objectId]);
    expect(recovered.failureObjectIds).toHaveLength(1);
    const objects = listCurrentObjects(root, branchId);
    expect(objects.find((object) => object.objectId === interrupted.objectId)?.content)
      .toMatchObject({ status: "interrupted" });
    expect(objects.find((object) => object.objectId === recovered.failureObjectIds[0])?.content)
      .toMatchObject({ kind: "verifier-execution-failure", status: "open" });
  });
});
