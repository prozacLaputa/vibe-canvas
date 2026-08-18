import assert from "node:assert/strict";
import test from "node:test";

import {
  createConceptGraph,
  projectConceptGraph,
  reduceConceptGraph,
  removeConceptEvidence,
} from "../src/concept-graph.js";

test("merges repeated topics and claims while preserving both source turns", () => {
  let graph = createConceptGraph();
  graph = reduceConceptGraph(
    graph,
    [
      { op: "upsert_domain", id: "domain-work", title: "职业" },
      {
        op: "upsert_topic",
        id: "topic-career-safety",
        domainId: "domain-work",
        title: "职业安全感",
        question: "怎样获得稳定且可控的职业感受？",
      },
      {
        op: "upsert_claim",
        id: "claim-career-uncertainty",
        primaryTopicId: "topic-career-safety",
        text: "主业支点偏薄，未来方向不够稳定。",
        type: "judgment",
      },
    ],
    { turnId: "turn-1" },
  );
  graph = reduceConceptGraph(
    graph,
    [
      {
        op: "upsert_topic",
        id: "topic-future-security",
        domainId: "domain-work",
        title: "职业未来的不安全感",
        question: "怎样获得稳定且可控的职业感受？",
      },
      {
        op: "upsert_claim",
        id: "claim-thin-career-anchor",
        primaryTopicId: "topic-future-security",
        text: "只有一条推进较慢的主线，职业支点太薄。",
        type: "judgment",
      },
      {
        op: "merge_topics",
        sourceId: "topic-future-security",
        targetId: "topic-career-safety",
      },
      {
        op: "merge_claims",
        sourceId: "claim-thin-career-anchor",
        targetId: "claim-career-uncertainty",
      },
    ],
    { turnId: "turn-2" },
  );

  assert.equal(graph.topics.length, 1);
  assert.equal(graph.claims.length, 1);
  assert.deepEqual(graph.claims[0].evidenceTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(graph.topics[0].aliases, ["职业未来的不安全感"]);
});

test("stores a cross-topic claim once and represents the overlap as a relation", () => {
  const graph = reduceConceptGraph(
    createConceptGraph(),
    [
      { op: "upsert_domain", id: "domain-work", title: "职业" },
      {
        op: "upsert_topic",
        id: "topic-industry-path",
        domainId: "domain-work",
        title: "行业路径变化",
        question: "互联网职业路径发生了什么变化？",
      },
      {
        op: "upsert_topic",
        id: "topic-career-safety",
        domainId: "domain-work",
        title: "职业安全感",
        question: "怎样获得稳定且可控的职业感受？",
      },
      {
        op: "upsert_claim",
        id: "claim-promotion-path",
        primaryTopicId: "topic-industry-path",
        relatedTopicIds: ["topic-career-safety"],
        text: "晋升阶梯收紧会进一步降低职业安全感。",
        type: "cause",
      },
      {
        op: "link",
        fromId: "topic-industry-path",
        toId: "topic-career-safety",
        type: "causes",
      },
    ],
    { turnId: "turn-cross" },
  );

  assert.equal(graph.claims.length, 1);
  assert.deepEqual(graph.claims[0].relatedTopicIds, ["topic-career-safety"]);
  assert.deepEqual(graph.relations, [
    {
      id: "topic-industry-path:causes:topic-career-safety",
      fromId: "topic-industry-path",
      toId: "topic-career-safety",
      type: "causes",
      evidenceTurnIds: ["turn-cross"],
    },
  ]);
});

test("keeps exact source evidence for the canvas while omitting quote text from the model projection", () => {
  const userText = "我不是不想探索，而是希望把 AI 作为支线，先保证主业稳定。";
  const graph = reduceConceptGraph(
    createConceptGraph(),
    [
      { op: "upsert_domain", id: "domain-work", title: "职业" },
      {
        op: "upsert_topic",
        id: "topic-path",
        domainId: "domain-work",
        title: "主业与探索",
        question: "怎样分配主业和 AI 探索？",
      },
      {
        op: "upsert_claim",
        id: "claim-side-project",
        primaryTopicId: "topic-path",
        text: "AI 探索暂时作为支线，主业稳定优先。",
        type: "decision",
        sourceQuote: "把 AI 作为支线，先保证主业稳定",
      },
    ],
    { turnId: "turn-evidence", userText },
  );

  assert.deepEqual(graph.claims[0].evidenceQuotes, [
    {
      turnId: "turn-evidence",
      text: "把 AI 作为支线，先保证主业稳定",
    },
  ]);
  assert.equal(projectConceptGraph(graph).claimIndex[0].evidenceQuotes, undefined);
  assert.deepEqual(
    projectConceptGraph(graph, { includeEvidenceQuotes: true }).claimIndex[0].evidenceQuotes,
    graph.claims[0].evidenceQuotes,
  );
  assert.throws(
    () =>
      reduceConceptGraph(
        createConceptGraph(),
        [
          { op: "upsert_domain", id: "domain-work", title: "职业" },
          {
            op: "upsert_topic",
            id: "topic-path",
            domainId: "domain-work",
            title: "主业与探索",
          },
          {
            op: "upsert_claim",
            id: "claim-invented",
            primaryTopicId: "topic-path",
            text: "AI 探索暂时作为支线。",
            sourceQuote: "用户从来没有说过的原文",
          },
        ],
        { turnId: "turn-invalid", userText },
      ),
    /exact substring of userText/,
  );
});

test("splits an overloaded topic by moving selected claims without duplicating them", () => {
  const graph = reduceConceptGraph(
    createConceptGraph(),
    [
      { op: "upsert_domain", id: "domain-life", title: "生活" },
      {
        op: "upsert_topic",
        id: "topic-family-catchall",
        domainId: "domain-life",
        title: "家庭问题",
        question: "家庭生活里有哪些问题？",
      },
      {
        op: "upsert_claim",
        id: "claim-housework",
        primaryTopicId: "topic-family-catchall",
        text: "双方已经形成基本家务分工。",
        type: "fact",
      },
      {
        op: "upsert_claim",
        id: "claim-purchase-delay",
        primaryTopicId: "topic-family-catchall",
        text: "必要物品在接手购买后长期没有行动。",
        type: "fact",
      },
      {
        op: "upsert_topic",
        id: "topic-action-boundary",
        domainId: "domain-life",
        title: "行动边界",
        question: "承诺没有执行时，怎样恢复行动权？",
      },
      {
        op: "move_claim",
        claimId: "claim-purchase-delay",
        primaryTopicId: "topic-action-boundary",
        relatedTopicIds: ["topic-family-catchall"],
      },
    ],
    { turnId: "turn-split" },
  );

  assert.equal(graph.claims.length, 2);
  const moved = graph.claims.find((claim) => claim.id === "claim-purchase-delay");
  assert.equal(moved.primaryTopicId, "topic-action-boundary");
  assert.deepEqual(moved.relatedTopicIds, ["topic-family-catchall"]);
});

test("removes one Pick source without deleting a concept that still has other evidence", () => {
  const operations = [
    { op: "upsert_domain", id: "domain-work", title: "职业" },
    {
      op: "upsert_topic",
      id: "topic-career-safety",
      domainId: "domain-work",
      title: "职业安全感",
      question: "怎样获得稳定且可控的职业感受？",
    },
    {
      op: "upsert_claim",
      id: "claim-career-uncertainty",
      primaryTopicId: "topic-career-safety",
      text: "主业支点偏薄。",
      type: "judgment",
    },
  ];
  let graph = reduceConceptGraph(createConceptGraph(), operations, { turnId: "turn-1" });
  graph = reduceConceptGraph(graph, operations, { turnId: "turn-2" });

  graph = removeConceptEvidence(graph, "turn-1");
  assert.equal(graph.claims.length, 1);
  assert.deepEqual(graph.claims[0].evidenceTurnIds, ["turn-2"]);

  graph = removeConceptEvidence(graph, "turn-2");
  assert.equal(graph.claims.length, 0);
  assert.equal(graph.topics.length, 0);
  assert.equal(graph.domains.length, 0);
});

test("keeps the default projection within a 25-node budget while retaining hidden detail", () => {
  const operations = [];
  for (let domainIndex = 1; domainIndex <= 4; domainIndex += 1) {
    const domainId = `domain-${domainIndex}`;
    operations.push({ op: "upsert_domain", id: domainId, title: `领域 ${domainIndex}` });
    for (let topicIndex = 1; topicIndex <= 4; topicIndex += 1) {
      const topicId = `${domainId}-topic-${topicIndex}`;
      operations.push({
        op: "upsert_topic",
        id: topicId,
        domainId,
        title: `主题 ${domainIndex}-${topicIndex}`,
        question: `问题 ${domainIndex}-${topicIndex}`,
      });
      for (let claimIndex = 1; claimIndex <= 4; claimIndex += 1) {
        operations.push({
          op: "upsert_claim",
          id: `${topicId}-claim-${claimIndex}`,
          primaryTopicId: topicId,
          text: `观点 ${domainIndex}-${topicIndex}-${claimIndex}`,
          type: claimIndex === 1 ? "decision" : "fact",
        });
      }
    }
  }
  const graph = reduceConceptGraph(createConceptGraph(), operations, { turnId: "turn-long" });
  const projection = projectConceptGraph(graph);

  assert.ok(projection.visibleNodeCount <= 25);
  assert.equal(projection.hiddenNodeCount, 84 - projection.visibleNodeCount);
  assert.ok(
    projection.domains.every((domain) =>
      domain.topics.every((topic) => topic.claims.length <= 3),
    ),
  );
  assert.equal(projection.topicIndex.length, 16);
});

test("keeps opposing claims separate instead of merging away a real disagreement", () => {
  const graph = reduceConceptGraph(
    createConceptGraph(),
    [
      { op: "upsert_domain", id: "domain-work", title: "职业" },
      {
        op: "upsert_topic",
        id: "topic-promotion",
        domainId: "domain-work",
        title: "晋升与风险",
        question: "晋升究竟提高还是降低安全感？",
      },
      {
        op: "upsert_claim",
        id: "claim-promotion-safe",
        primaryTopicId: "topic-promotion",
        text: "晋升可以增加资源和确定性。",
        type: "judgment",
      },
      {
        op: "upsert_claim",
        id: "claim-promotion-risk",
        primaryTopicId: "topic-promotion",
        text: "晋升也可能提高裁员和再就业风险。",
        type: "judgment",
      },
      {
        op: "link",
        fromId: "claim-promotion-risk",
        toId: "claim-promotion-safe",
        type: "contradicts",
      },
    ],
    { turnId: "turn-conflict" },
  );

  assert.equal(graph.claims.length, 2);
  assert.equal(graph.relations[0].type, "contradicts");
});

test("automatically collapses exact canonical duplicates even when a later turn invents new ids", () => {
  let graph = reduceConceptGraph(
    createConceptGraph(),
    [
      { op: "upsert_domain", id: "domain-work", title: "职业" },
      {
        op: "upsert_topic",
        id: "topic-career-safety",
        domainId: "domain-work",
        title: "职业安全感",
        question: "怎样获得稳定且可控的职业感受？",
      },
      {
        op: "upsert_claim",
        id: "claim-thin-anchor",
        primaryTopicId: "topic-career-safety",
        text: "主业支点偏薄，未来方向不够稳定。",
        type: "judgment",
      },
    ],
    { turnId: "turn-1" },
  );

  graph = reduceConceptGraph(
    graph,
    [
      { op: "upsert_domain", id: "domain-career", title: " 职 业 " },
      {
        op: "upsert_topic",
        id: "topic-future-security",
        domainId: "domain-career",
        title: "职业未来的不安全感",
        question: "怎样获得稳定、且可控的职业感受",
      },
      {
        op: "upsert_claim",
        id: "claim-thin-anchor-again",
        primaryTopicId: "topic-future-security",
        text: "主业支点偏薄 未来方向不够稳定",
        type: "judgment",
      },
    ],
    { turnId: "turn-2" },
  );

  assert.equal(graph.domains.length, 1);
  assert.equal(graph.topics.length, 1);
  assert.equal(graph.claims.length, 1);
  assert.deepEqual(graph.topics[0].evidenceTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(graph.claims[0].evidenceTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(graph.topics[0].aliases, ["职业未来的不安全感"]);
});

test("prioritizes the most recently active domains in the bounded projection", () => {
  let graph = createConceptGraph();
  for (let index = 1; index <= 6; index += 1) {
    graph = reduceConceptGraph(
      graph,
      [
        { op: "upsert_domain", id: `domain-${index}`, title: `领域 ${index}` },
        {
          op: "upsert_topic",
          id: `topic-${index}`,
          domainId: `domain-${index}`,
          title: `主题 ${index}`,
          question: `问题 ${index}`,
        },
        {
          op: "upsert_claim",
          id: `claim-${index}`,
          primaryTopicId: `topic-${index}`,
          text: `第 ${index} 轮的新结论`,
          type: "insight",
        },
      ],
      { turnId: `turn-${index}` },
    );
  }

  const projection = projectConceptGraph(graph);
  const visibleDomainIds = projection.domains.map((domain) => domain.id);
  assert.ok(visibleDomainIds.includes("domain-6"));
  assert.ok(!visibleDomainIds.includes("domain-1"));
});

test("keeps a compact claim index so hidden claims can still be matched on later turns", () => {
  const operations = [
    { op: "upsert_domain", id: "domain-work", title: "职业" },
    {
      op: "upsert_topic",
      id: "topic-career",
      domainId: "domain-work",
      title: "职业路径",
      question: "职业路径应该如何选择？",
    },
  ];
  for (let index = 1; index <= 10; index += 1) {
    operations.push({
      op: "upsert_claim",
      id: `claim-${index}`,
      primaryTopicId: "topic-career",
      text: `观点 ${index}`,
      type: "fact",
    });
  }
  const graph = reduceConceptGraph(createConceptGraph(), operations, { turnId: "turn-many" });
  const projection = projectConceptGraph(graph, { maxNodes: 4 });
  const visibleClaimIds = projection.domains[0].topics[0].claims.map((claim) => claim.id);

  assert.ok(projection.hiddenNodeCount > 0);
  assert.equal(projection.claimIndex.length, 10);
  assert.ok(
    projection.claimIndex.some((claim) => !visibleClaimIds.includes(claim.id)),
    "at least one hidden claim must remain available for duplicate matching",
  );
});

test("keeps projection provenance bounded while the full graph retains every source turn", () => {
  const operations = [
    { op: "upsert_domain", id: "domain-work", title: "职业" },
    {
      op: "upsert_topic",
      id: "topic-career",
      domainId: "domain-work",
      title: "职业安全感",
      question: "怎样获得稳定且可控的职业感受？",
    },
    {
      op: "upsert_claim",
      id: "claim-anchor",
      primaryTopicId: "topic-career",
      text: "主业支点偏薄。",
      type: "judgment",
    },
  ];
  let graph = createConceptGraph();
  for (let index = 1; index <= 100; index += 1) {
    graph = reduceConceptGraph(graph, operations, { turnId: `turn-${index}` });
  }

  const projection = projectConceptGraph(graph);
  const projectedClaim = projection.claimIndex[0];
  assert.equal(graph.claims[0].evidenceTurnIds.length, 100);
  assert.equal(projectedClaim.evidenceCount, 100);
  assert.deepEqual(projectedClaim.recentEvidenceTurnIds, ["turn-98", "turn-99", "turn-100"]);
  assert.equal("evidenceTurnIds" in projectedClaim, false);
  assert.ok(JSON.stringify(projection).length < 5_000);
});
