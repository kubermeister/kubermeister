import { z } from 'zod';
import { chartRepositoryNameSchema } from './charts.js';

/**
 * What the values editor starts from: the chart's own `values.yaml`, as its author wrote it, comments
 * included, and the `values.schema.json` beside it when the chart ships one. The schema is JSON
 * Schema (draft-07 and later), a different dialect from the OpenAPI the cluster publishes for its
 * kinds, and it is whatever the chart's author wrote, so it crosses the bridge as plain JSON and the
 * walker reading it trusts none of its keywords to have the shape the specification gives them.
 */

/** A JSON Schema: `true` and `false` are schemas too, allowing everything and nothing. */
export const jsonSchemaSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

export const chartVersionInputSchema = z.object({
    /** The configured repository or registry, by its name. */
    source: chartRepositoryNameSchema,
    chart: z.string().min(1).max(253),
    version: z.string().min(1).max(128),
});

export const chartValuesSchema = z.object({
    /** The chart's `values.yaml`; empty for a chart that ships none. */
    valuesYaml: z.string(),
    /** The parsed `values.schema.json`, or null when there is none or it could not be read. */
    schema: jsonSchemaSchema.nullable(),
    /** Why a `values.schema.json` the chart does ship is not used, in a sentence; null otherwise. */
    schemaProblem: z.string().nullable(),
    /**
     * The top-level keys holding a dependency's values (its alias, or its name), from `Chart.yaml`.
     * A subchart's section is checked against the subchart's own schema, so this one says nothing
     * about it.
     */
    subcharts: z.array(z.string()),
});

export type JsonSchema = z.infer<typeof jsonSchemaSchema>;
export type ChartVersionInput = z.infer<typeof chartVersionInputSchema>;
export type ChartValues = z.infer<typeof chartValuesSchema>;
