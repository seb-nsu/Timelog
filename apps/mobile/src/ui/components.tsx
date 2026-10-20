// Bausteine der Oberfläche: barrierefrei (Rollen, Beschriftungen, Zustände), skalierbare Schrift
// (keine festen Höhen, nur Mindestgrößen), Touch-Ziele ≥ 48.
import { type ReactNode, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOUCH, type Theme, space, useTheme } from './theme';

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={[styles.screen, { paddingTop: insets.top + space.md }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        {title}
      </Text>
      {children}
    </ScrollView>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.section, { backgroundColor: theme.surface }]}>
      {title ? (
        <Text accessibilityRole="header" style={[styles.h2, { color: theme.text }]}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const theme = useTheme();
  return <Text style={[styles.body, { color: muted ? theme.muted : theme.text }]}>{children}</Text>;
}

export function Big({ children, label }: { children: ReactNode; label?: string }) {
  const theme = useTheme();
  return (
    <Text accessibilityLabel={label} style={[styles.big, { color: theme.text }]}>
      {children}
    </Text>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';

function buttonColors(theme: Theme, variant: Variant) {
  if (variant === 'primary')
    return { bg: theme.primary, fg: theme.onPrimary, border: theme.primary };
  if (variant === 'danger') return { bg: theme.danger, fg: theme.onDanger, border: theme.danger };
  return { bg: 'transparent', fg: theme.primary, border: theme.primary };
}

export interface ButtonProps {
  label: string;
  onPress: () => unknown;
  variant?: Variant;
  hint?: string;
  disabled?: boolean;
  testID?: string;
}

/** Knopf; bei asynchronem onPress gesperrt, bis die Aktion fertig ist. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  hint,
  disabled,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const c = buttonColors(theme, variant);
  const off = disabled === true || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={() => {
        const result = onPress();
        if (result instanceof Promise) {
          setBusy(true);
          void result.finally(() => {
            setBusy(false);
          });
        }
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: c.bg, borderColor: c.border, opacity: off ? 0.6 : pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, { color: c.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={theme.muted}
        style={[
          styles.input,
          { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg },
        ]}
        {...props}
      />
      {hint ? <Text style={[styles.small, { color: theme.muted }]}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  label,
  value,
  onValueChange,
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => unknown;
  hint?: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={[styles.body, { color: theme.text }]}>{label}</Text>
        {hint ? <Text style={[styles.small, { color: theme.muted }]}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled: disabled === true }}
        disabled={disabled}
        value={value}
        onValueChange={(v) => {
          void onValueChange(v);
        }}
        trackColor={{ true: theme.primary, false: theme.border }}
      />
    </View>
  );
}

export type Tone = 'info' | 'warning' | 'error' | 'success';

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const theme = useTheme();
  const colors = {
    info: [theme.infoBg, theme.infoText],
    warning: [theme.warningBg, theme.warningText],
    error: [theme.errorBg, theme.errorText],
    success: [theme.successBg, theme.successText],
  }[tone];
  return (
    <View
      accessible
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
      style={[styles.notice, { backgroundColor: colors[0] }]}
    >
      <Text style={[styles.body, { color: colors[1] }]}>{children}</Text>
    </View>
  );
}

/** Beschriftung und Wert, für Screenreader als eine Zeile vorgelesen. */
export function Row({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const content = (
    <>
      <Text style={[styles.body, styles.rowLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.body, { color: theme.text, fontWeight: '600' }]}>{value}</Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        onPress={onPress}
        style={[styles.row, { minHeight: TOUCH }]}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.row}>
      {content}
    </View>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** Auswahl aus wenigen Möglichkeiten (Radiogruppe). */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ checked: selected }}
              onPress={() => {
                onChange(o.value);
              }}
              style={[
                styles.choice,
                {
                  borderColor: selected ? theme.primary : theme.border,
                  backgroundColor: selected ? theme.primary : 'transparent',
                },
              ]}
            >
              <Text style={[styles.body, { color: selected ? theme.onPrimary : theme.text }]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Gap() {
  return <View style={{ height: space.sm }} />;
}

export const styles = StyleSheet.create({
  screen: { padding: space.md, paddingBottom: space.lg * 2, gap: space.md },
  h1: { fontSize: 28, fontWeight: '700' },
  h2: { fontSize: 20, fontWeight: '600', marginBottom: space.xs },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 14, lineHeight: 19 },
  big: { fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontSize: 16, fontWeight: '600' },
  section: { borderRadius: 12, padding: space.md, gap: space.sm },
  button: {
    minHeight: TOUCH,
    borderRadius: 10,
    borderWidth: 2,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  field: { gap: space.xs },
  input: {
    minHeight: TOUCH,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: space.sm,
    fontSize: 16,
  },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: TOUCH },
  toggleText: { flex: 1 },
  notice: { borderRadius: 8, padding: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm },
  rowLabel: { flexShrink: 1 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  choice: {
    minHeight: TOUCH,
    borderWidth: 2,
    borderRadius: 20,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
});
