// 个人长期记忆对群聊的归属边界。
// 在场不等于亲历：只有角色自己说的、别人直接对他说的、或直接发生在他身上的消息，
// 才能进入他的记忆总结。提示词里的近期群聊上下文不受这里影响。

export type GroupMemoryParty = {
    characterId: string;
    /** 用于点名匹配的名字。单字名只做整段相等匹配，避免从别人的句子里误伤。 */
    names: string[];
};

export type GroupMemoryMessage = {
    id: string;
    role: string;
    content?: string;
    senderCharacterId?: string;
    senderName?: string;
    mediaData?: {
        quoteMessageId?: string;
        quotePreview?: string;
        pokeSender?: string;
        pokeTarget?: string;
        recipientName?: string;
        senderName?: string;
        claimer?: string;
        owner?: string;
        adminActorName?: string;
        adminTargetName?: string;
        label?: string;
        meetingInviteCharacterId?: string;
    };
};

export type GroupMemoryContext = {
    /** 群里除用户外只有这一个角色时，用户的话就是对他说的。 */
    soloCharacterGroup: boolean;
    senderByMessageId: ReadonlyMap<string, { characterId?: string; senderName?: string }>;
};

function cleanNames(names: string[]): string[] {
    return names.map(name => name.trim()).filter(Boolean);
}

function equalsName(text: string | undefined, names: string[]): boolean {
    const hay = text?.trim();
    if (!hay) return false;
    return names.some(name => name === hay);
}

/** 正文里的点名。两字及以上才做包含匹配。 */
export function textMentionsCharacter(text: string | undefined | null, names: string[]): boolean {
    const hay = text?.trim();
    if (!hay) return false;
    for (const name of cleanNames(names)) {
        if (hay === name) return true;
        if (name.length >= 2 && hay.includes(name)) return true;
    }
    return false;
}

function quotedMessageIsFromCharacter(
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): boolean {
    const quoteId = message.mediaData?.quoteMessageId;
    if (!quoteId) return false;
    const quoted = context.senderByMessageId.get(quoteId);
    if (!quoted) return false;
    if (quoted.characterId && quoted.characterId === party.characterId) return true;
    return equalsName(quoted.senderName, party.names);
}

/**
 * 这条群消息算不算「这个角色的亲历」。
 * 多人群里，用户没点名、其他角色在讲自己的事，都返回 false。
 */
export function groupMessageInvolvesCharacter(
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): boolean {
    const names = cleanNames(party.names);
    const scopedParty = { ...party, names };
    if (message.senderCharacterId && message.senderCharacterId === party.characterId) return true;
    if (equalsName(message.senderName, names)) return true;
    if (context.soloCharacterGroup && message.role !== "system") return true;
    if (message.mediaData?.meetingInviteCharacterId === party.characterId) return true;
    if (quotedMessageIsFromCharacter(message, scopedParty, context)) return true;

    const addressed = [
        message.content,
        message.mediaData?.quotePreview,
        message.mediaData?.pokeSender,
        message.mediaData?.pokeTarget,
        message.mediaData?.recipientName,
        message.mediaData?.senderName,
        message.mediaData?.claimer,
        message.mediaData?.owner,
        message.mediaData?.adminActorName,
        message.mediaData?.adminTargetName,
        message.mediaData?.label,
    ];
    return addressed.some(text => textMentionsCharacter(text, names));
}
