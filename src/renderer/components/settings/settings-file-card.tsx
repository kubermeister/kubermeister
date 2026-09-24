import { FolderOpenIcon } from 'lucide-react';
import { StatusDot } from '@/components/data-display/status-dot';
import { FormCard } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import { revealSettingsFile, useSettingsFile } from '@/lib/settings';

/**
 * Where every setting on this screen is kept, and what is wrong with the file while anything is.
 * A provisioned file is somebody's configuration, so a value the app refused is named here rather
 * than quietly replaced by its default.
 */
export function SettingsFileCard() {
    const { data: file } = useSettingsFile();

    return (
        <FormCard
            title="Settings file"
            desc="Everything on this screen is kept in this file, which you can also write by hand."
            action={
                <Button variant="outline" size="sm" onClick={() => void revealSettingsFile()}>
                    <FolderOpenIcon />
                    Show file
                </Button>
            }
        >
            <div className="flex flex-col gap-2" data-testid="settings-file">
                <span className="truncate font-mono text-cell text-text-2" title={file?.path}>
                    {file?.path ?? '—'}
                </span>
                {file && !file.exists && (
                    <p className="text-cell text-text-muted">
                        No file yet: every setting is at its default. The first change made here creates it.
                    </p>
                )}
                {file?.readOnly && (
                    <p className="flex items-start gap-2 text-cell text-danger" data-testid="settings-file-read-only">
                        <StatusDot tone="danger" className="mt-1.5" />
                        <span>{file.readOnly}</span>
                    </p>
                )}
                {file && file.problems.length > 0 && (
                    <ul className="flex flex-col gap-1 text-cell" data-testid="settings-file-problems">
                        {file.problems.map((problem) => (
                            <li key={`${problem.path}:${problem.message}`} className="flex items-start gap-2">
                                <StatusDot tone="warn" className="mt-1.5" />
                                <span>
                                    <code className="font-mono text-text-2">{problem.path}</code>{' '}
                                    <span className="text-text-muted">{problem.message}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </FormCard>
    );
}
