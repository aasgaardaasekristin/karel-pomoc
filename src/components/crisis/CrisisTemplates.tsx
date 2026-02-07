import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Mail, Check } from "lucide-react";
import { toast } from "sonner";

interface Template {
  id: string;
  label: string;
  description: string;
  subject: string;
  body: string;
}

const templates: Template[] = [
  {
    id: "a",
    label: "A) První odpověď – telefon volitelný",
    description: "Potvrzení kódu 11, hranice, žádost o časové okno, telefon jen se souhlasem.",
    subject: "Re: Kód 11 – děkuji za zprávu",
    body: `Dobrý den,

děkuji, že jste se ozvali. Kód 11 jsem přijala a rozumím tomu, co znamená – bylo vám hodně těžko a krátká pomoc nestačila.

Chci být upřímná: nejsem krizová služba a nemohu garantovat okamžitou dostupnost. Ale jsem tu a chci s vámi najít cestu dál.

Potřebuji od vás dvě věci:
1. Časové okno, kdy by vám vyhovovalo se spojit (dopoledne / odpoledne / večer).
2. Pokud byste chtěli krátký telefonát (10–15 minut), pošlete mi prosím své telefonní číslo. Použiji ho pouze pro tento jeden domluvený hovor.

Pokud vám telefonát nevyhovuje, klidně zůstaneme u psané formy – to je naprosto v pořádku.

Pro případ, že byste potřebovali okamžitou pomoc dříve, než se ozveme:
• Krizová linka: 116 123 (non-stop, zdarma)
• Linka bezpečí: 116 111 (pro děti a dospívající)

S pozdravem`,
  },
  {
    id: "b",
    label: "B) Varianta – psaná forma (bez telefonu)",
    description: "Respektuje neochotu mluvit, žádost o 1–2 věty.",
    subject: "Re: Kód 11 – jsem tu",
    body: `Dobrý den,

přijala jsem váš kód 11. Cením si toho, že jste se ozvali – vím, že to není snadné.

Nemusíte nic vysvětlovat do detailu. Pokud chcete, napište mi jen 1–2 věty o tom, co je teď nejtěžší. Můžeme pokračovat psanou formou, tak jak vám to vyhovuje.

Rozhodnutí je na vás – tempo i rozsah. Já jsem tady.

Kdybyste potřebovali okamžitou pomoc:
• Krizová linka: 116 123 (non-stop, zdarma)

S pozdravem`,
  },
  {
    id: "c",
    label: "C) Varianta – výrazná beznaděj / odmítání všeho",
    description: "Normalizuje odpor, jemně povzbuzuje, nevytváří tlak.",
    subject: "Re: Kód 11",
    body: `Dobrý den,

dostala jsem vaši zprávu. Slyším vás.

Vím, že někdy i samotný krok napsat zprávu je obrovský. A vím, že možná teď nevěříte, že by cokoli mohlo pomoct. To je pochopitelné.

Nebudu vás tlačit do ničeho. Nebudu od vás nic očekávat. Ale jsem tu – a kdyby přišel moment, kdy budete chtít říct jednu větu, jednu myšlenku, jsem připravená ji přijmout.

Není žádný tlak. Není žádný termín.

Kdybyste cítili, že je to příliš:
• Krizová linka: 116 123 (kdykoli, zdarma)
• Policie ČR: 158 (při akutním ohrožení)

S pozdravem`,
  },
];

const CrisisTemplates = () => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (template: Template) => {
    try {
      await navigator.clipboard.writeText(template.body);
      setCopiedId(template.id);
      toast.success("Zkopírováno do schránky");
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error("Nepodařilo se zkopírovat");
    }
  };

  const handleEmail = (template: Template) => {
    const mailto = `mailto:?subject=${encodeURIComponent(template.subject)}&body=${encodeURIComponent(template.body)}`;
    window.open(mailto, "_blank");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Hotové šablony pro odpověď osobě s kódem 11. Můžeš zkopírovat nebo vložit do e-mailu jedním klikem.
      </p>
      {templates.map((t) => (
        <div key={t.id} className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-muted/40 border-b border-border">
            <p className="text-sm font-medium text-foreground">{t.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
          </div>
          <div className="px-4 py-3">
            <pre className="whitespace-pre-wrap text-xs text-foreground/80 font-sans leading-relaxed max-h-40 overflow-y-auto">
              {t.body}
            </pre>
          </div>
          <div className="flex gap-2 px-4 py-2 border-t border-border bg-muted/20">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => handleCopy(t)}
            >
              {copiedId === t.id ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
              {copiedId === t.id ? "Zkopírováno" : "Kopírovat"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => handleEmail(t)}
            >
              <Mail className="w-3 h-3 mr-1" />
              Vložit do e-mailu
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default CrisisTemplates;
