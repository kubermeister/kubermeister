import { CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import type { SecretEntry } from '../../../shared/k8s/workloads';
import { Button } from '@/components/ui/button';
import { DetailCard } from '@/components/templates/detail-cards';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { REVEAL_TIMEOUT_MS, useSecretReveal } from '@/lib/secret-reveal';

const REVEAL_SECONDS = Math.round(REVEAL_TIMEOUT_MS / 1000);

/**
 * The Keys tab: every value masked until it is asked for by name. Revealing and copying are
 * separate on purpose — a copy puts the value on the clipboard without ever rendering it, which is
 * what most of these keys are wanted for.
 */
export function SecretKeysCard({
    name,
    namespace,
    entries,
}: {
    name: string;
    namespace: string;
    entries: SecretEntry[];
}) {
    const { shown, pending, toggle, copy } = useSecretReveal(name, namespace);

    return (
        <DetailCard title="Data" desc={`A revealed value masks itself again after ${REVEAL_SECONDS} seconds`}>
            <Table data-testid="secret-keys">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[200px]">Key</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead className="w-[90px] text-right">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {entries.map((entry) => {
                        const value = shown(entry.key);
                        return (
                            <TableRow key={entry.key} data-secret-key={entry.key}>
                                <TableCell className="font-mono text-primary">{entry.key}</TableCell>
                                <TableCell className="font-mono text-text-muted">
                                    {value ? (
                                        <span className="break-all text-text-2" data-testid={`value-${entry.key}`}>
                                            {value.value}
                                            {value.binary && (
                                                <span className="ml-2 text-meta text-text-muted">(base64)</span>
                                            )}
                                        </span>
                                    ) : (
                                        <span className="tracking-widest">{entry.masked}</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right whitespace-nowrap">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                disabled={pending === entry.key}
                                                aria-label={`${value ? 'Hide' : 'Reveal'} ${entry.key}`}
                                                onClick={() => toggle(entry.key)}
                                            >
                                                {value ? <EyeOffIcon /> : <EyeIcon />}
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>{value ? 'Hide the value' : 'Reveal the value'}</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                disabled={pending === entry.key}
                                                aria-label={`Copy ${entry.key}`}
                                                onClick={() => copy(entry.key)}
                                            >
                                                <CopyIcon />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Copy without showing it</TooltipContent>
                                    </Tooltip>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </DetailCard>
    );
}
