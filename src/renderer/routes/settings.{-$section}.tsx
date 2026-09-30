import { createFileRoute } from '@tanstack/react-router';
import {
    GaugeIcon,
    InfoIcon,
    PackageIcon,
    PaletteIcon,
    PlugIcon,
    RefreshCwIcon,
    SlidersHorizontalIcon,
} from 'lucide-react';
import { AboutCard } from '@/components/settings/about-card';
import { AppearanceSection } from '@/components/settings/appearance-section';
import { ChartRepositoriesCard } from '@/components/settings/chart-repositories-card';
import { ClusterDataSection } from '@/components/settings/cluster-data-section';
import { ConnectionSection } from '@/components/settings/connection-section';
import { GeneralSection } from '@/components/settings/general-section';
import { UpdatesSection } from '@/components/settings/updates-section';
import { SettingsPage, type SettingsSection } from '@/components/templates/settings-page';

export const Route = createFileRoute('/settings/{-$section}')({
    component: SettingsScreen,
    // A section switch is the rail moving within one screen, not another screen: remounting on it
    // would take the rail's focus away mid-keystroke.
    remountDeps: () => ({}),
});

/** The ids are URL segments other screens link to (`/settings/charts`), so they outlive a relabel. */
const SECTIONS: SettingsSection[] = [
    { id: 'general', label: 'General', icon: SlidersHorizontalIcon, content: <GeneralSection /> },
    { id: 'appearance', label: 'Appearance', icon: PaletteIcon, content: <AppearanceSection /> },
    { id: 'data', label: 'Cluster data', icon: GaugeIcon, content: <ClusterDataSection /> },
    { id: 'connection', label: 'Connection', icon: PlugIcon, content: <ConnectionSection /> },
    { id: 'charts', label: 'Charts', icon: PackageIcon, content: <ChartRepositoriesCard /> },
    { id: 'updates', label: 'Updates', icon: RefreshCwIcon, content: <UpdatesSection /> },
    { id: 'about', label: 'About', icon: InfoIcon, content: <AboutCard /> },
];

function SettingsScreen() {
    return <SettingsPage title="Settings" desc="Preferences for this Kubermeister install." sections={SECTIONS} />;
}
