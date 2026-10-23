import { type Transporter, createTransport } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Sammelt Mails im Speicher (Tests). */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];

  send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
    return Promise.resolve();
  }
}

/** Nur für lokale Entwicklung ohne SMTP: gibt Mails auf stdout aus, nie in Produktion. */
export class ConsoleMailer implements Mailer {
  send(mail: Mail): Promise<void> {
    process.stdout.write(`\n--- Mail an ${mail.to}: ${mail.subject}\n${mail.text}\n---\n`);
    return Promise.resolve();
  }
}
