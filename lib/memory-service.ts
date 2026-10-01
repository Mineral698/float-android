// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { effectiveSalience, memoryKindOf } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Generative Agents 三维检索：score = α·recency + β·salience + γ·relevance
    // recency 半衰期 ~7 天（exp(-ageDays/7)）；relevance = embedding cosine。
    // reflection/trait_shift 是高层记忆，轻微加成——它们更该被"想起"。
    const nowMs = Date.now();
    const recencyScore = (entry: MemoryEntry) => {
        const ageDays = Math.max(0, (nowMs - new Date(entry.createdAt).getTime()) / 86400000);
        return Math.exp(-ageDays / 7);
    };
    const salienceScore = (entry: MemoryEntry) => effectiveSalience(entry) / 10;
    const kindBonus = (entry: MemoryEntry) => {
        const kind = memoryKindOf(entry);
        return kind === "reflection" || kind === "trait_shift" ? 1.1 : 1.0;
    };

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const scored = longTermEntries.map(entry => ({
                entry,
                score: (0.3 * recencyScore(entry)
                    + 0.3 * salienceScore(entry)
                    + 0.4 * (entry.embedding?.length ? Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding)) : 0))
                    * kindBonus(entry),
            }));
            scored.sort((a, b) => b.score - a.score);
            return fillByBudget(scored.map(s => s.entry), budget);
        }
    }

    // 无 embedding：recency + salience 两维（各占一半）
    const scored = longTermEntries.map(entry => ({
        entry,
        score: (0.5 * recencyScore(entry) + 0.5 * salienceScore(entry)) * kindBonus(entry),
    }));
    scored.sort((a, b) => b.score - a.score);
    return fillByBudget(scored.map(s => s.entry), budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
