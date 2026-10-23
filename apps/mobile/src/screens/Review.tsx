// Zu prüfen (auf „Heute“): Sitzungen mit Prüfwarnungen oder offener Entscheidung (zweite Sitzung,
// Tag ohne Soll); mit eingeschalteter Kalender-Anbindung auch Vorschläge aus dem Kalender.
import { formatClock, formatDate, reviewItems } from '@timelog/app-core';
import { Body, Button, Notice, Section } from '../ui/components';
import { useMobile } from '../ui/context';
import { CalendarSuggestionsSection } from './Extras';

export function ReviewSection() {
  const { core, state, days, t, go } = useMobile();
  const items = reviewItems(days);
  return (
    <>
      {state.settings.calendar ? <CalendarSuggestionsSection /> : null}
      {items.length > 0 ? (
        <Section title={`${t.m('review.title')} (${String(items.length)})`}>
          {items.map((item) => {
            const from = formatClock(item.from, item.tz);
            const to = item.to ? formatClock(item.to, item.tz) : '…';
            return (
              <Section key={item.sessionId} title={formatDate(item.date, t.tag)}>
                <Body>{t.t('review.session', { from, to })}</Body>
                {item.warnings.map((w) => (
                  <Notice key={w} tone="warning">
                    {t.warning(w)}
                  </Notice>
                ))}
                {item.needsDecision ? (
                  <>
                    <Button
                      label={t.m('review.confirm')}
                      hint={t.m('review.confirmHint', { from, to })}
                      onPress={() => core.decideSession(item.sessionId, true)}
                    />
                    <Button
                      variant="secondary"
                      label={t.m('review.reject')}
                      hint={t.m('review.rejectHint', { from, to })}
                      onPress={() => core.decideSession(item.sessionId, false)}
                    />
                  </>
                ) : null}
                <Button
                  variant="secondary"
                  label={t.m('review.openDay')}
                  onPress={() => {
                    go({ name: 'log', date: item.date });
                  }}
                />
              </Section>
            );
          })}
        </Section>
      ) : null}
    </>
  );
}
