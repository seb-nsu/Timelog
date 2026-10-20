// Oberfläche der Handy-App: Einrichtungsassistent beim ersten Start, danach fünf Reiter.
import { reviewItems } from '@timelog/app-core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AbsencesScreen } from './screens/Absences';
import { DayLogScreen } from './screens/DayLog';
import { OverviewScreen } from './screens/Overview';
import { ReviewScreen } from './screens/Review';
import { SettingsScreen } from './screens/Settings';
import { SetupScreen } from './screens/Setup';
import { TodayScreen } from './screens/Today';
import { WeekScreen } from './screens/Week';
import { MobileProvider, type MobileProviderProps, type Route, useMobile } from './ui/context';
import { TOUCH, useTheme } from './ui/theme';

type Tab = 'today' | 'log' | 'review' | 'overview' | 'settings';

function tabOf(route: Route): Tab {
  if (route.name === 'absences' || route.name === 'week') return 'overview';
  if (route.name === 'setup') return 'settings';
  return route.name;
}

function Content() {
  const { route, state } = useMobile();
  if (!state.setupDone || route.name === 'setup') return <SetupScreen />;
  switch (route.name) {
    case 'today':
      return <TodayScreen />;
    case 'log':
      return (
        <DayLogScreen key={route.date ?? 'today'} {...(route.date ? { date: route.date } : {})} />
      );
    case 'review':
      return <ReviewScreen />;
    case 'overview':
      return <OverviewScreen />;
    case 'week':
      return (
        <WeekScreen key={route.date ?? 'week'} {...(route.date ? { date: route.date } : {})} />
      );
    case 'absences':
      return <AbsencesScreen />;
    case 'settings':
      return <SettingsScreen />;
  }
}

function TabBar() {
  const { route, go, t, days, state } = useMobile();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (!state.setupDone) return null;
  const active = tabOf(route);
  const reviewCount = reviewItems(days).length;
  const tabs: { name: Tab; label: string }[] = [
    { name: 'today', label: t.m('tab.today') },
    { name: 'log', label: t.m('tab.log') },
    { name: 'review', label: t.m('tab.review') },
    { name: 'overview', label: t.m('tab.overview') },
    { name: 'settings', label: t.m('tab.settings') },
  ];
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {tabs.map((tab) => {
        const selected = tab.name === active;
        const badge = tab.name === 'review' && reviewCount > 0;
        const label = badge
          ? t.m('tab.badge', { label: tab.label, count: reviewCount })
          : tab.label;
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            onPress={() => {
              go({ name: tab.name });
            }}
            style={styles.tab}
          >
            <Text
              numberOfLines={2}
              style={[
                styles.tabText,
                {
                  color: selected ? theme.primary : theme.muted,
                  fontWeight: selected ? '700' : '500',
                },
              ]}
            >
              {badge ? `${tab.label} (${String(reviewCount)})` : tab.label}
            </Text>
            {selected ? (
              <View style={[styles.indicator, { backgroundColor: theme.primary }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Shell() {
  const theme = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={styles.content}>
        <Content />
      </View>
      <TabBar />
    </View>
  );
}

export function App(props: Omit<MobileProviderProps, 'children'>) {
  return (
    <SafeAreaProvider>
      <MobileProvider {...props}>
        <Shell />
      </MobileProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    minHeight: TOUCH + 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  tabText: { fontSize: 13, textAlign: 'center' },
  indicator: { height: 3, width: '60%', borderRadius: 2, marginTop: 4 },
});
