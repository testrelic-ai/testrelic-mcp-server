import type { z } from "zod";

/**
 * Minimal zod → JSON-Schema converter covering the primitive shapes we use
 * in elicitation. Falls back to `{type:"object"}` for anything exotic.
 * Reads zod 4's `_zod.def`, whose `type` replaced zod 3's `_def.typeName`.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _zod: { def: { type: string; [k: string]: unknown } } })._zod.def;
  switch (def.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: Object.values((def as unknown as { entries: Record<string, string> }).entries) };
    case "optional":
      return zodToJsonSchema((def as unknown as { innerType: z.ZodType }).innerType);
    case "default":
      return zodToJsonSchema((def as unknown as { innerType: z.ZodType }).innerType);
    case "array":
      return { type: "array", items: zodToJsonSchema((def as unknown as { element: z.ZodType }).element) };
    case "object": {
      const shape = (def as unknown as { shape: Record<string, z.ZodType> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!(v as unknown as { isOptional?: () => boolean }).isOptional?.()) required.push(k);
      }
      return { type: "object", properties, required: required.length ? required : undefined };
    }
    default:
      return { type: "object" };
  }
}
