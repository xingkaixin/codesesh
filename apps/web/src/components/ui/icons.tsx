/**
 * Hugeicons 适配层：把图标数据包装成组件，保持调用点写 `<Star className="size-4" />`
 * 而不是 `<HugeiconsIcon icon={StarIcon} .../>`。图标选型集中在本文件，换图标只改这里。
 */
import {
  BookOpenTextIcon,
  BrowserIcon,
  CalendarRangeIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  CircleIcon,
  Clock01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  CopyIcon,
  File01Icon,
  FileAddIcon,
  FileEditIcon,
  FileSearchIcon,
  FunnelIcon,
  GoalIcon,
  HelpCircleIcon,
  IdeaIcon,
  ImageIcon,
  Loading02Icon,
  Message01Icon,
  MessageCancel01Icon,
  MinusSignIcon,
  MoonIcon,
  MoreHorizontalIcon,
  NoteEditIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  Plug01Icon,
  RobotIcon,
  Search01Icon,
  StarIcon,
  SunIcon,
  UserIcon,
  UserMultipleIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";

export type IconProps = Omit<HugeiconsIconProps, "icon" | "altIcon" | "showAlt">;

function toIcon(icon: IconSvgElement) {
  return function Icon(props: IconProps) {
    return <HugeiconsIcon icon={icon} {...props} />;
  };
}

export const BookOpenText = toIcon(BookOpenTextIcon);
export const Bot = toIcon(RobotIcon);
export const CalendarRange = toIcon(CalendarRangeIcon);
export const Check = toIcon(CheckIcon);
export const CheckCircle2 = toIcon(CheckmarkCircle02Icon);
export const ChevronDown = toIcon(ChevronDownIcon);
export const ChevronLeft = toIcon(ChevronLeftIcon);
export const ChevronRight = toIcon(ChevronRightIcon);
export const ChevronUp = toIcon(ChevronUpIcon);
export const Circle = toIcon(CircleIcon);
export const CircleDashed = toIcon(CircleDashedIcon);
export const CircleHelp = toIcon(HelpCircleIcon);
export const Clock3 = toIcon(Clock01Icon);
export const Copy = toIcon(CopyIcon);
export const FilePenLine = toIcon(FileEditIcon);
export const FilePlus2 = toIcon(FileAddIcon);
export const FileSearch = toIcon(FileSearchIcon);
export const FileText = toIcon(File01Icon);
export const Funnel = toIcon(FunnelIcon);
export const Image = toIcon(ImageIcon);
export const Lightbulb = toIcon(IdeaIcon);
export const ListTodo = toIcon(CheckListIcon);
export const LoaderCircle = toIcon(Loading02Icon);
export const MessageCircleX = toIcon(MessageCancel01Icon);
export const MessageSquareMore = toIcon(Message01Icon);
export const Minus = toIcon(MinusSignIcon);
export const Monitor = toIcon(ComputerIcon);
export const Moon = toIcon(MoonIcon);
export const MoreHorizontal = toIcon(MoreHorizontalIcon);
export const NotebookPen = toIcon(NoteEditIcon);
// Hugeicons draws these arrows opposite to their names (Close points right,
// Open points left), so the mapping is swapped to keep the visual direction correct.
export const PanelLeftClose = toIcon(PanelLeftOpenIcon);
export const PanelLeftOpen = toIcon(PanelLeftCloseIcon);
export const PanelsTopLeft = toIcon(BrowserIcon);
export const Pencil = toIcon(PencilIcon);
export const Plug = toIcon(Plug01Icon);
export const Search = toIcon(Search01Icon);
export const SquareTerminal = toIcon(ComputerTerminal01Icon);
export const Star = toIcon(StarIcon);
export const Sun = toIcon(SunIcon);
export const Target = toIcon(GoalIcon);
export const UserRound = toIcon(UserIcon);
export const Users = toIcon(UserMultipleIcon);
export const Wrench = toIcon(WrenchIcon);
export const X = toIcon(Cancel01Icon);
export const XCircle = toIcon(CancelCircleIcon);
