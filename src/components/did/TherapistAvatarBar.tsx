import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import avatarKarel from "@/assets/avatar-karel.png";
import avatarHanicka from "@/assets/avatar-hanicka.png";

const avatars = [
  { name: "Karel Gustav Jung", fallback: "K", src: avatarKarel },
  { name: "Hanička", fallback: "H", src: avatarHanicka },
] as const;

const TherapistAvatarBar = () => (
  <TooltipProvider delayDuration={300}>
    <div className="flex items-center -space-x-2.5">
      {avatars.map((a, i) => (
        <Tooltip key={a.name}>
          <TooltipTrigger asChild>
            <Avatar
              className="border-2 border-background shadow-md"
              style={{
                width: i === 0 ? 40 : 36,
                height: i === 0 ? 40 : 36,
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

export default TherapistAvatarBar;
