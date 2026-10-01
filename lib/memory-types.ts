// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

/** Generative Agents 式记忆分层：
 *  episode     单个关键事件（"下午和X打球输了"），links 指回所属 summary
 *  summary     叙事压缩（旧数据的缺省形态）
 *  reflection  跨记忆高层推理，links 指向证据条目
 *  trait_shift 性格漂移记录，links 指向触发它的 reflection/episode */
export type MemoryKind = "episode" | "summary" | "reflection" | "trait_shift";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
    /** 记忆分层；旧条目无此字段，按 "summary" 处理 */
    kind?: MemoryKind;
    /** 1-10，LLM 评的重要性/poignancy；旧条目按 importance*10 折算 */
    salience?: number;
    /** derivedFrom：本条目由哪些条目支撑（episode→summary、reflection→证据） */
    links?: string[];
};

export function memoryKindOf(entry: Pick<MemoryEntry, "kind">): MemoryKind {
    return entry.kind ?? "summary";
}

export function effectiveSalience(entry: Pick<MemoryEntry, "salience" | "importance">): number {
    const raw = typeof entry.salience === "number" && Number.isFinite(entry.salience)
        ? entry.salience
        : entry.importance * 10;
    return Math.min(10, Math.max(1, Math.round(raw)));
}

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * v2 总结模板：除叙事摘要外，要求输出结构化 episode 列表。
 * 每行 EPISODE|<重要性1-10>|<一句话事件> —— 重要性反映"对{{char}}来说
 * 这段经历多难忘/多影响关系"（日常琐事=1-3，有意义的互动=4-7，
 * 关系里程碑/强烈情绪事件=8-10）。
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT_V2 = `你是一个记忆整理助手。根据以下事件记录，为{{char}}整理记忆。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

严格按以下格式输出（不要输出任何其他内容）：

SUMMARY:
<一段简洁的事实性总结，第三人称描述{{char}}和用户之间的互动，保留关键事实：名字、承诺、情感变化、关系里程碑、用户分享的生日/偏好/习惯，保留朋友圈等非聊天事件关键信息，100-200字>

EPISODES:
EPISODE|<重要性1-10>|<一句话描述一个值得独立记住的事件>
EPISODE|<重要性1-10>|<另一个事件>
（每行一条，最多8条，宁缺毋滥；只挑真正值得单独记住的时刻）

人称约定：所有输出（SUMMARY 与每条 EPISODE）都必须用第三人称——用"用户"指代用户、用"{{char}}"指代角色；写"用户告诉了{{char}}自己的生日"而不是"我的生日"或"TA的生日"。

重要性评分标准：日常琐事=1-3，有意义的互动=4-7，关系里程碑/强烈情绪事件=8-10`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT_V2,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
