export const MESSAGE_POLICIES = [
  'everyone',
  'followers',
  'friends',
  'teammates',
  'nobody',
] as const;

export type MessagePolicy = (typeof MESSAGE_POLICIES)[number];

export type MessageRestriction =
  | 'MESSAGES_CLOSED'
  | 'MESSAGES_FRIENDS_ONLY'
  | 'MESSAGES_FOLLOWERS_ONLY'
  | 'MESSAGES_TEAMMATES_ONLY'
  | 'MESSAGES_BLOCKED'
  | 'MESSAGES_REQUEST_PENDING';

export interface MessageAccess {
  allowed: boolean;
  policy: MessagePolicy;
  restriction: MessageRestriction | null;
  isFriend: boolean;
  isFollowing: boolean;
}

export const RESTRICTION_MESSAGE: Record<MessageRestriction, string> = {
  MESSAGES_CLOSED: 'This user is not accepting messages',
  MESSAGES_FRIENDS_ONLY: 'Only friends can message this user',
  MESSAGES_FOLLOWERS_ONLY: 'Only friends and followers can message this user',
  MESSAGES_TEAMMATES_ONLY: 'Only teammates or friends can message this user',
  MESSAGES_BLOCKED: 'Cannot message this user',
  MESSAGES_REQUEST_PENDING: 'You can send more once they reply',
};

export const REQUEST_VIOLATION_MESSAGE = {
  MESSAGE_REQUEST_TEXT_ONLY: 'Only text can be sent before they reply',
  MESSAGE_REQUEST_TOO_LONG: 'Keep your first message short',
  MESSAGE_REQUEST_NO_LINKS: 'Links can’t be sent before they reply',
  MESSAGE_REQUEST_NO_CONTACT_INFO:
    'Phone numbers can’t be sent before they reply',
} as const;

export function normalizeMessagePolicy(value: unknown): MessagePolicy {
  return (MESSAGE_POLICIES as readonly string[]).includes(value as string)
    ? (value as MessagePolicy)
    : 'everyone';
}
