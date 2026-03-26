import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import avatarKarel from "@/assets/avatar-karel.png";
import avatarHanicka from "@/assets/avatar-hanicka.png";
import avatarKata from "@/assets/avatar-kata.png";

type AvatarDef = { name: string; fallback: string; src: string };

const allAvatars: Record<string, AvatarDef> = {
  karel: { name: "Karel Gustav Jung", fallback: "K", src: avatarKarel },
  hanicka: { name: "Hanička", fallback: "H", src: avatarHanicka },
  kata: { name: "Káťa", fallback: "Ká", src: avatarKata },
};

const presets: Record<string, string[]> = {
  meeting: ["kata", "karel", "hanicka"],
  all: ["karel", "hanicka", "kata"],
  mamka: ["karel", "hanicka"],
  kata: ["karel", "kata"],
};

interface Props {
  variant?: "all" | "mamka" | "kata" | "meeting";
}

const TherapistAvatarBar = ({ variant = "all" }: Props) => {
  const keys = presets[variant] || presets.all;
  const avatars = keys.map((k) => allAvatars[k]);
  const baseSize = variant === "all" ? 36 : 40;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center -space-x-2.5">
        {avatars.map((a, i) => (
          <Tooltip key={a.name}>
            <TooltipTrigger asChild>
              <Avatar
                className="border-2 border-background shadow-md"
                style={{
                  width: i === 0 ? baseSize + 4 : baseSize,
                  height: i === 0 ? baseSize + 4 : baseSize,
                  zIndex: avatars.length - i,
                }}
              >
                <AvatarImage src={a.src} alt={a.name} className="object-cover" />
                <AvatarFallback className="text-xs font-semibold bg-muted text-muted-foreground">
                  {a.fallback}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {a.name}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
};

export default TherapistAvatarBar;
