export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

export type Digest = {
  done: string[];
  next: string[];
  new_blockers: string[];
  resolved_blocker_ids: number[];
  digestMd: string;
};
