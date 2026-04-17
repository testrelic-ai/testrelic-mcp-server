import type { z } from "zod";

/**
 * Minimal zod → JSON-Schema converter covering the primitive shapes we use
 * in elicitation. Falls back to `{type:"object"}` for anything exotic.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string; [k: string]: unknown } })._def;
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: (def as unknown as { values: string[] }).values };
    case "ZodOptional":
      return zodToJsonSchema((def as unknown as { innerType: z.ZodType }).innerType);
    case "ZodDefault":
      return zodToJsonSchema((def as unknown as { innerType: z.ZodType }).innerType);
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema((def as unknown as { type: z.ZodType }).type) };
    case "ZodObject": {
      const shape = (def as unknown as { shape: () => Record<string, z.ZodType> }).shape();
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
