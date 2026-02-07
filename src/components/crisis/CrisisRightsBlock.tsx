import { Scale } from "lucide-react";

const CrisisRightsBlock = () => (
  <div className="space-y-3">
    <div className="flex items-start gap-2 text-sm text-muted-foreground">
      <Scale className="w-4 h-4 mt-0.5 shrink-0" />
      <p className="italic">Orientační rámec – nejedná se o právní poradenství.</p>
    </div>
    <ul className="space-y-2 text-sm text-foreground/90 pl-1">
      <li className="flex items-start gap-2">
        <span className="text-primary mt-1">•</span>
        <span>Terapeutka <strong>není krizová služba</strong> a nemá povinnost být nepřetržitě dostupná.</span>
      </li>
      <li className="flex items-start gap-2">
        <span className="text-primary mt-1">•</span>
        <span>Nemá povinnost aktivně vyhledávat osobu, která se s kódem 11 neozvala.</span>
      </li>
      <li className="flex items-start gap-2">
        <span className="text-primary mt-1">•</span>
        <span>Odpovědnost za rozhodnutí kontaktovat terapeutku zůstává na klientovi.</span>
      </li>
      <li className="flex items-start gap-2">
        <span className="text-primary mt-1">•</span>
        <span>V případě akutního ohrožení života je správný postup odkázání na krizové služby (116 123) nebo IZS (112, 155, 158).</span>
      </li>
      <li className="flex items-start gap-2">
        <span className="text-primary mt-1">•</span>
        <span>Je legitimní stanovit si hranice ohledně dostupnosti, formy a rozsahu kontaktu.</span>
      </li>
    </ul>
  </div>
);

export default CrisisRightsBlock;
