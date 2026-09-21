import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { TEMPLATES } from '@/lib/create-templates';

interface Manifest {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string };
}

const parsed = TEMPLATES.map((template) => ({ template, manifest: load(template.yaml) as Manifest }));

describe('create screen templates', () => {
    it('offers every kind under its own name, with no two sharing an id', () => {
        expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
        expect(new Set(TEMPLATES.map((t) => t.label)).size).toBe(TEMPLATES.length);
    });

    it('parses as YAML and declares the kind and api version the selector names', () => {
        for (const { template, manifest } of parsed) {
            expect(manifest.kind, template.id).toBe(template.label);
            expect(manifest.apiVersion, template.id).toBe(template.api);
        }
    });

    it('names an object but never a namespace, which the active selection supplies', () => {
        for (const { template, manifest } of parsed) {
            expect(manifest.metadata?.name, template.id).toBeTruthy();
            expect(manifest.metadata?.namespace, template.id).toBeUndefined();
        }
    });

    it('starts the kinds a user reaches for after the workloads', () => {
        expect(TEMPLATES.map((t) => t.label)).toEqual(
            expect.arrayContaining([
                'Job',
                'PersistentVolumeClaim',
                'ServiceAccount',
                'Role',
                'RoleBinding',
                'NetworkPolicy',
                'HorizontalPodAutoscaler',
            ]),
        );
    });
});
