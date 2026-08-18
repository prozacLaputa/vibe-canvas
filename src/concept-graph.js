const GRAPH_VERSION = 1;
const CLAIM_TYPES = new Set([
  "fact",
  "judgment",
  "cause",
  "decision",
  "question",
  "action",
  "meta",
  "insight",
]);
const RELATION_TYPES = new Set([
  "causes",
  "supports",
  "contradicts",
  "depends_on",
  "example_of",
  "related_to",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeSemanticKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function addEvidence(node, turnId, sequence) {
  node.evidenceTurnIds = unique([...(node.evidenceTurnIds ?? []), turnId]);
  node.lastTouchedSequence = sequence;
}

function resolveAlias(aliases, id) {
  let resolved = id;
  const visited = new Set();
  while (aliases.has(resolved) && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = aliases.get(resolved);
  }
  return resolved;
}

function registerAlias(aliases, requestedId, canonicalId) {
  if (requestedId && requestedId !== canonicalId) aliases.set(requestedId, canonicalId);
  return canonicalId;
}

function requireNode(nodes, id, kind) {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Unknown ${kind}: ${id ?? ""}`);
  return node;
}

function requireAnyNode(graph, id) {
  const node = [...graph.domains, ...graph.topics, ...graph.claims].find(
    (candidate) => candidate.id === id,
  );
  if (!node) throw new Error(`Unknown concept node: ${id ?? ""}`);
  return node;
}

function replaceRelationEndpoint(relations, sourceId, targetId) {
  for (const relation of relations) {
    if (relation.fromId === sourceId) relation.fromId = targetId;
    if (relation.toId === sourceId) relation.toId = targetId;
  }
}

function normalizeRelations(relations) {
  const normalized = new Map();
  for (const relation of relations) {
    if (relation.fromId === relation.toId) continue;
    const id = `${relation.fromId}:${relation.type}:${relation.toId}`;
    const existing = normalized.get(id);
    if (existing) {
      existing.evidenceTurnIds = unique([
        ...existing.evidenceTurnIds,
        ...relation.evidenceTurnIds,
      ]);
    } else {
      normalized.set(id, { ...relation, id });
    }
  }
  return [...normalized.values()];
}

export function createConceptGraph() {
  return {
    version: GRAPH_VERSION,
    sequence: 0,
    domains: [],
    topics: [],
    claims: [],
    relations: [],
  };
}

export function reduceConceptGraph(currentGraph, operations, { turnId, userText = "" } = {}) {
  if (!turnId) throw new Error("turnId is required.");
  if (!Array.isArray(operations)) throw new Error("operations must be an array.");
  const graph = structuredClone(currentGraph ?? createConceptGraph());
  graph.sequence = (graph.sequence ?? 0) + 1;
  const sequence = graph.sequence;
  const aliases = new Map();

  for (const operation of operations) {
    switch (operation?.op) {
      case "upsert_domain": {
        if (!operation.id || !operation.title?.trim()) {
          throw new Error("upsert_domain requires id and title.");
        }
        const title = operation.title.trim();
        const requestedId = resolveAlias(aliases, operation.id);
        let domain = graph.domains.find((candidate) => candidate.id === requestedId);
        if (!domain) {
          const titleKey = normalizeSemanticKey(title);
          if (titleKey) {
            domain = graph.domains.find(
              (candidate) =>
                normalizeSemanticKey(candidate.title) === titleKey ||
                candidate.aliases?.some((alias) => normalizeSemanticKey(alias) === titleKey),
            );
          }
        }
        if (!domain) {
          domain = { id: operation.id, title, aliases: [], evidenceTurnIds: [] };
          graph.domains.push(domain);
        } else {
          registerAlias(aliases, operation.id, domain.id);
          if (domain.title !== title) domain.aliases = unique([...(domain.aliases ?? []), title]);
        }
        addEvidence(domain, turnId, sequence);
        break;
      }
      case "upsert_topic": {
        if (!operation.id || !operation.title?.trim()) {
          throw new Error("upsert_topic requires id and title.");
        }
        const domainId = operation.domainId
          ? resolveAlias(aliases, operation.domainId)
          : null;
        if (domainId) requireNode(graph.domains, domainId, "domain");
        const title = operation.title.trim();
        const question = operation.question?.trim() ?? "";
        const requestedId = resolveAlias(aliases, operation.id);
        let topic = graph.topics.find((candidate) => candidate.id === requestedId);
        if (!topic) {
          const questionKey = normalizeSemanticKey(question);
          const titleKey = normalizeSemanticKey(title);
          topic = graph.topics.find((candidate) => {
            if ((candidate.domainId ?? null) !== domainId) return false;
            if (questionKey) return normalizeSemanticKey(candidate.question) === questionKey;
            return Boolean(
              titleKey &&
                (normalizeSemanticKey(candidate.title) === titleKey ||
                  candidate.aliases?.some((alias) => normalizeSemanticKey(alias) === titleKey)),
            );
          });
        }
        if (!topic) {
          topic = {
            id: operation.id,
            domainId,
            title,
            question,
            aliases: [],
            evidenceTurnIds: [],
          };
          graph.topics.push(topic);
        } else {
          registerAlias(aliases, operation.id, topic.id);
          if (topic.title !== title) topic.aliases = unique([...(topic.aliases ?? []), title]);
        }
        addEvidence(topic, turnId, sequence);
        break;
      }
      case "upsert_claim": {
        if (!operation.id || !operation.text?.trim() || !operation.primaryTopicId) {
          throw new Error("upsert_claim requires id, text, and primaryTopicId.");
        }
        const primaryTopicId = resolveAlias(aliases, operation.primaryTopicId);
        const relatedTopicIds = unique(
          (operation.relatedTopicIds ?? []).map((topicId) => resolveAlias(aliases, topicId)),
        ).filter((topicId) => topicId !== primaryTopicId);
        requireNode(graph.topics, primaryTopicId, "topic");
        for (const topicId of relatedTopicIds) {
          requireNode(graph.topics, topicId, "topic");
        }
        const claimType = operation.type ?? "insight";
        if (!CLAIM_TYPES.has(claimType)) {
          throw new Error(`Unsupported claim type: ${claimType}`);
        }
        const requestedId = resolveAlias(aliases, operation.id);
        const text = operation.text.trim();
        const sourceQuote = operation.sourceQuote?.trim() ?? "";
        if (sourceQuote && !userText.includes(sourceQuote)) {
          throw new Error("sourceQuote must be an exact substring of userText.");
        }
        let claim = graph.claims.find((candidate) => candidate.id === requestedId);
        if (!claim) {
          const textKey = normalizeSemanticKey(text);
          const topicIds = new Set([primaryTopicId, ...relatedTopicIds]);
          if (textKey) {
            claim = graph.claims.find(
              (candidate) =>
                normalizeSemanticKey(candidate.text) === textKey &&
                [candidate.primaryTopicId, ...(candidate.relatedTopicIds ?? [])].some((topicId) =>
                  topicIds.has(topicId),
                ),
            );
          }
        }
        if (!claim) {
          claim = {
            id: operation.id,
            primaryTopicId,
            relatedTopicIds,
            text,
            alternateTexts: [],
            type: claimType,
            evidenceTurnIds: [],
            evidenceQuotes: [],
          };
          graph.claims.push(claim);
        } else {
          registerAlias(aliases, operation.id, claim.id);
          claim.relatedTopicIds = unique([
            ...(claim.relatedTopicIds ?? []),
            primaryTopicId,
            ...relatedTopicIds,
          ]).filter((topicId) => topicId !== claim.primaryTopicId);
        }
        if (claim.text !== text) {
          claim.alternateTexts = unique([...(claim.alternateTexts ?? []), text]);
        }
        claim.evidenceQuotes ??= [];
        if (
          sourceQuote &&
          !claim.evidenceQuotes.some(
            (evidence) => evidence.turnId === turnId && evidence.text === sourceQuote,
          )
        ) {
          claim.evidenceQuotes.push({ turnId, text: sourceQuote });
        }
        addEvidence(claim, turnId, sequence);
        break;
      }
      case "merge_topics": {
        const sourceId = resolveAlias(aliases, operation.sourceId);
        const targetId = resolveAlias(aliases, operation.targetId);
        const source = requireNode(graph.topics, sourceId, "topic");
        const target = requireNode(graph.topics, targetId, "topic");
        if (source.id === target.id) break;
        target.aliases = unique([...target.aliases, source.title, ...source.aliases]).filter(
          (title) => title !== target.title,
        );
        target.evidenceTurnIds = unique([...target.evidenceTurnIds, ...source.evidenceTurnIds]);
        target.evidenceQuotes = [
          ...(target.evidenceQuotes ?? []),
          ...(source.evidenceQuotes ?? []),
        ].filter(
          (evidence, index, entries) =>
            entries.findIndex(
              (candidate) =>
                candidate.turnId === evidence.turnId && candidate.text === evidence.text,
            ) === index,
        );
        for (const claim of graph.claims) {
          if (claim.primaryTopicId === source.id) claim.primaryTopicId = target.id;
          claim.relatedTopicIds = unique(
            claim.relatedTopicIds.map((topicId) => (topicId === source.id ? target.id : topicId)),
          ).filter((topicId) => topicId !== claim.primaryTopicId);
        }
        replaceRelationEndpoint(graph.relations, source.id, target.id);
        graph.topics = graph.topics.filter((topic) => topic.id !== source.id);
        registerAlias(aliases, operation.sourceId, target.id);
        aliases.set(source.id, target.id);
        addEvidence(target, turnId, sequence);
        break;
      }
      case "merge_claims": {
        const sourceId = resolveAlias(aliases, operation.sourceId);
        const targetId = resolveAlias(aliases, operation.targetId);
        const source = requireNode(graph.claims, sourceId, "claim");
        const target = requireNode(graph.claims, targetId, "claim");
        if (source.id === target.id) break;
        target.alternateTexts = unique([
          ...target.alternateTexts,
          source.text,
          ...source.alternateTexts,
        ]).filter((text) => text !== target.text);
        target.relatedTopicIds = unique([
          ...target.relatedTopicIds,
          source.primaryTopicId,
          ...source.relatedTopicIds,
        ]).filter((topicId) => topicId !== target.primaryTopicId);
        target.evidenceTurnIds = unique([...target.evidenceTurnIds, ...source.evidenceTurnIds]);
        replaceRelationEndpoint(graph.relations, source.id, target.id);
        graph.claims = graph.claims.filter((claim) => claim.id !== source.id);
        registerAlias(aliases, operation.sourceId, target.id);
        aliases.set(source.id, target.id);
        addEvidence(target, turnId, sequence);
        break;
      }
      case "link": {
        const fromId = resolveAlias(aliases, operation.fromId);
        const toId = resolveAlias(aliases, operation.toId);
        requireAnyNode(graph, fromId);
        requireAnyNode(graph, toId);
        if (!RELATION_TYPES.has(operation.type)) {
          throw new Error(`Unsupported relation type: ${operation.type ?? ""}`);
        }
        const id = `${fromId}:${operation.type}:${toId}`;
        let relation = graph.relations.find((candidate) => candidate.id === id);
        if (!relation) {
          relation = {
            id,
            fromId,
            toId,
            type: operation.type,
            evidenceTurnIds: [],
          };
          graph.relations.push(relation);
        }
        relation.evidenceTurnIds = unique([...(relation.evidenceTurnIds ?? []), turnId]);
        break;
      }
      case "move_claim": {
        const claim = requireNode(
          graph.claims,
          resolveAlias(aliases, operation.claimId),
          "claim",
        );
        const primaryTopicId = resolveAlias(aliases, operation.primaryTopicId);
        const relatedTopicIds = unique(
          (operation.relatedTopicIds ?? []).map((topicId) => resolveAlias(aliases, topicId)),
        );
        requireNode(graph.topics, primaryTopicId, "topic");
        for (const topicId of relatedTopicIds) {
          requireNode(graph.topics, topicId, "topic");
        }
        claim.primaryTopicId = primaryTopicId;
        claim.relatedTopicIds = relatedTopicIds.filter(
          (topicId) => topicId !== claim.primaryTopicId,
        );
        claim.lastTouchedSequence = sequence;
        break;
      }
      default:
        throw new Error(`Unsupported concept operation: ${operation?.op ?? ""}`);
    }
  }

  graph.relations = normalizeRelations(graph.relations);
  return graph;
}

export function removeConceptEvidence(currentGraph, turnId) {
  if (!turnId) throw new Error("turnId is required.");
  const graph = structuredClone(currentGraph ?? createConceptGraph());
  for (const node of [...graph.domains, ...graph.topics, ...graph.claims, ...graph.relations]) {
    node.evidenceTurnIds = (node.evidenceTurnIds ?? []).filter(
      (evidenceTurnId) => evidenceTurnId !== turnId,
    );
  }
  for (const claim of graph.claims) {
    claim.evidenceQuotes = (claim.evidenceQuotes ?? []).filter(
      (evidence) => evidence.turnId !== turnId,
    );
  }

  graph.claims = graph.claims.filter((claim) => claim.evidenceTurnIds.length > 0);
  const referencedTopicIds = new Set(
    graph.claims.flatMap((claim) => [claim.primaryTopicId, ...claim.relatedTopicIds]),
  );
  graph.topics = graph.topics.filter(
    (topic) => topic.evidenceTurnIds.length > 0 || referencedTopicIds.has(topic.id),
  );
  const remainingTopicIds = new Set(graph.topics.map((topic) => topic.id));
  for (const claim of graph.claims) {
    claim.relatedTopicIds = claim.relatedTopicIds.filter((topicId) => remainingTopicIds.has(topicId));
  }
  const referencedDomainIds = new Set(graph.topics.map((topic) => topic.domainId).filter(Boolean));
  graph.domains = graph.domains.filter(
    (domain) => domain.evidenceTurnIds.length > 0 || referencedDomainIds.has(domain.id),
  );
  const remainingNodeIds = new Set(
    [...graph.domains, ...graph.topics, ...graph.claims].map((node) => node.id),
  );
  graph.relations = graph.relations.filter(
    (relation) =>
      relation.evidenceTurnIds.length > 0 &&
      remainingNodeIds.has(relation.fromId) &&
      remainingNodeIds.has(relation.toId),
  );
  return graph;
}

const CLAIM_TYPE_PRIORITY = {
  decision: 7,
  question: 6,
  action: 5,
  cause: 4,
  judgment: 3,
  fact: 2,
  insight: 1,
};

function claimScore(claim) {
  return (claim.evidenceTurnIds?.length ?? 0) * 10 + (CLAIM_TYPE_PRIORITY[claim.type] ?? 0);
}

function claimActivity(claim) {
  return claim.lastTouchedSequence ?? 0;
}

function topicActivity(graph, topic) {
  const claimSequence = graph.claims
    .filter(
      (claim) =>
        claim.primaryTopicId === topic.id || claim.relatedTopicIds?.includes(topic.id),
    )
    .reduce((latest, claim) => Math.max(latest, claimActivity(claim)), 0);
  return Math.max(topic.lastTouchedSequence ?? 0, claimSequence);
}

function domainActivity(graph, domain) {
  const topicSequence = graph.topics
    .filter((topic) => topic.domainId === domain.id)
    .reduce((latest, topic) => Math.max(latest, topicActivity(graph, topic)), 0);
  return Math.max(domain.lastTouchedSequence ?? 0, topicSequence);
}

function compactEvidence(node) {
  const evidenceTurnIds = node.evidenceTurnIds ?? [];
  return {
    evidenceCount: evidenceTurnIds.length,
    recentEvidenceTurnIds: structuredClone(evidenceTurnIds.slice(-3)),
  };
}

function compactDomain(domain) {
  return {
    id: domain.id,
    title: domain.title,
    aliases: structuredClone(domain.aliases ?? []),
    ...compactEvidence(domain),
    lastTouchedSequence: domain.lastTouchedSequence ?? 0,
  };
}

function compactTopic(topic) {
  return {
    id: topic.id,
    domainId: topic.domainId,
    title: topic.title,
    question: topic.question,
    aliases: structuredClone(topic.aliases ?? []),
    ...compactEvidence(topic),
    lastTouchedSequence: topic.lastTouchedSequence ?? 0,
  };
}

function compactClaim(claim, { includeEvidenceQuotes = false, maxEvidenceQuotes = 5 } = {}) {
  const evidenceQuotes = claim.evidenceQuotes ?? [];
  const compact = {
    id: claim.id,
    primaryTopicId: claim.primaryTopicId,
    relatedTopicIds: structuredClone(claim.relatedTopicIds ?? []),
    text: claim.text,
    alternateTexts: structuredClone(claim.alternateTexts ?? []),
    type: claim.type,
    ...compactEvidence(claim),
    lastTouchedSequence: claim.lastTouchedSequence ?? 0,
  };
  if (includeEvidenceQuotes) {
    compact.evidenceQuotes = structuredClone(evidenceQuotes.slice(-maxEvidenceQuotes));
    compact.hiddenEvidenceQuoteCount = Math.max(0, evidenceQuotes.length - maxEvidenceQuotes);
  }
  return compact;
}

function compactRelation(relation) {
  return {
    id: relation.id,
    fromId: relation.fromId,
    toId: relation.toId,
    type: relation.type,
    ...compactEvidence(relation),
  };
}

export function projectConceptGraph(
  currentGraph,
  {
    maxNodes = 25,
    maxDomains = 5,
    maxTopicsPerDomain = 4,
    maxClaimsPerTopic = 3,
    maxClaimIndex = 40,
    includeEvidenceQuotes = false,
    maxEvidenceQuotes = 5,
  } = {},
) {
  const graph = currentGraph ?? createConceptGraph();
  const domains = [...graph.domains]
    .sort((left, right) => domainActivity(graph, right) - domainActivity(graph, left))
    .slice(0, Math.min(maxDomains, maxNodes));
  let remaining = Math.max(0, maxNodes - domains.length);
  const topicsByDomain = new Map(
    domains.map((domain) => [
      domain.id,
      graph.topics
        .filter((topic) => topic.domainId === domain.id)
        .sort((left, right) => {
          const activityDifference = topicActivity(graph, right) - topicActivity(graph, left);
          if (activityDifference) return activityDifference;
          const leftScore = graph.claims
            .filter((claim) => claim.primaryTopicId === left.id)
            .reduce((sum, claim) => sum + claimScore(claim), 0);
          const rightScore = graph.claims
            .filter((claim) => claim.primaryTopicId === right.id)
            .reduce((sum, claim) => sum + claimScore(claim), 0);
          return rightScore - leftScore;
        }),
    ]),
  );
  const topicBudget = Math.min(
    Math.floor(remaining / 2),
    domains.length * maxTopicsPerDomain,
  );
  const selectedTopics = [];
  for (let round = 0; round < maxTopicsPerDomain && selectedTopics.length < topicBudget; round += 1) {
    for (const domain of domains) {
      const topic = topicsByDomain.get(domain.id)?.[round];
      if (!topic) continue;
      selectedTopics.push(topic);
      if (selectedTopics.length === topicBudget) break;
    }
  }
  remaining -= selectedTopics.length;

  const selectedClaims = new Map(selectedTopics.map((topic) => [topic.id, []]));
  const claimQueues = new Map(
    selectedTopics.map((topic) => [
      topic.id,
      graph.claims
        .filter((claim) => claim.primaryTopicId === topic.id)
        .sort((left, right) => {
          const activityDifference = claimActivity(right) - claimActivity(left);
          return activityDifference || claimScore(right) - claimScore(left);
        }),
    ]),
  );
  for (let round = 0; round < maxClaimsPerTopic && remaining > 0; round += 1) {
    for (const topic of selectedTopics) {
      const claim = claimQueues.get(topic.id)?.[round];
      if (!claim) continue;
      selectedClaims.get(topic.id).push(claim);
      remaining -= 1;
      if (remaining === 0) break;
    }
  }

  const nestedDomains = domains.map((domain) => ({
    ...compactDomain(domain),
    topics: selectedTopics
      .filter((topic) => topic.domainId === domain.id)
      .map((topic) => ({
        ...compactTopic(topic),
        claims: (selectedClaims.get(topic.id) ?? []).map((claim) =>
          compactClaim(claim, { includeEvidenceQuotes, maxEvidenceQuotes }),
        ),
        hiddenClaimCount: Math.max(
          0,
          (claimQueues.get(topic.id)?.length ?? 0) - (selectedClaims.get(topic.id)?.length ?? 0),
        ),
      })),
  }));
  const visibleNodeIds = new Set([
    ...domains.map((domain) => domain.id),
    ...selectedTopics.map((topic) => topic.id),
    ...[...selectedClaims.values()].flat().map((claim) => claim.id),
  ]);
  const visibleNodeCount = visibleNodeIds.size;
  const totalNodeCount = graph.domains.length + graph.topics.length + graph.claims.length;

  return {
    domains: nestedDomains,
    relations: graph.relations
      .filter(
        (relation) =>
          visibleNodeIds.has(relation.fromId) && visibleNodeIds.has(relation.toId),
      )
      .map(compactRelation),
    topicIndex: [...graph.topics]
      .sort((left, right) => topicActivity(graph, right) - topicActivity(graph, left))
      .map(({ id, domainId, title, question, aliases, lastTouchedSequence }) => ({
        id,
        domainId,
        title,
        question,
        aliases: structuredClone(aliases),
        lastTouchedSequence: lastTouchedSequence ?? 0,
      })),
    claimIndex: [...graph.claims]
      .sort((left, right) => {
        const activityDifference = claimActivity(right) - claimActivity(left);
        return activityDifference || claimScore(right) - claimScore(left);
      })
      .slice(0, maxClaimIndex)
      .map((claim) => compactClaim(claim, { includeEvidenceQuotes, maxEvidenceQuotes })),
    omittedClaimIndexCount: Math.max(0, graph.claims.length - maxClaimIndex),
    visibleNodeCount,
    hiddenNodeCount: Math.max(0, totalNodeCount - visibleNodeCount),
  };
}
