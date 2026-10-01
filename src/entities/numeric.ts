import { ValueTransformer } from "typeorm";

// pg returns numeric and bigint as strings; values here fit safely in a JS number.
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value ?? null,
  from: (value?: string | null) => (value === null || value === undefined ? null : Number(value)),
};

export const bigintTransformer: ValueTransformer = {
  to: (value?: number | null) => value ?? null,
  from: (value?: string | null) => (value === null || value === undefined ? null : Number(value)),
};
