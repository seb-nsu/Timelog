// Englische Oberfläche: Sprache kommt aus der Browsersprache und wird beim Laden festgelegt.
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

type AppModule = typeof import('../src/App.js');
type FakeModule = typeof import('./fake.js');
let App: AppModule['App'];
let fakeServer: FakeModule['fakeServer'];
let signedIn: FakeModule['signedIn'];

beforeAll(async () => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-GB', configurable: true });
  vi.resetModules();
  // Nach resetModules auch die Fakes neu laden, damit ApiError dieselbe Klasse ist.
  ({ App } = await import('../src/App.js'));
  ({ fakeServer, signedIn } = await import('./fake.js'));
});

function renderApp(server: ReturnType<typeof fakeServer>, loggedIn = true) {
  render(
    <App
      session={signedIn(server, loggedIn)}
      initialUrl="http://admin.test/"
      redirectTo={vi.fn()}
      download={vi.fn()}
      replaceUrl={vi.fn()}
      now={() => Date.parse('2026-10-20T10:00:00Z')}
    />,
  );
}

describe('English', () => {
  it('login screen and error messages are in English', async () => {
    renderApp(fakeServer({ loginNeedsTotp: true }), false);
    await userEvent.type(await screen.findByLabelText('Email'), 'alex@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-enough');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Please enter the code from your authenticator app.'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in with SSO' })).toBeTruthy();
  });

  it('navigation and approvals are in English', async () => {
    renderApp(fakeServer());
    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    const nav = within(screen.getByRole('navigation', { name: 'Sections' }));
    for (const name of ['Leave', 'Members', 'Settings', 'Payroll', 'Audit log', 'My calendar']) {
      expect(nav.getByRole('button', { name })).toBeTruthy();
    }
    await userEvent.click(nav.getByRole('button', { name: 'Members' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Invite person' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    // Kein deutscher Bedientext auf der Seite
    expect(document.body.textContent).not.toMatch(/Mitglieder|Abmelden|Einladen/);
  });
});
