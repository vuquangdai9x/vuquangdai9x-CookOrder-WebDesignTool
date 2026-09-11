export type Language = "en" | "vi";

const STORAGE_KEY = "cookorder-language";

const VIETNAMESE: Record<string, string> = {
  "Map Process": "Quy trình bản đồ",
  "Level Path": "Lộ trình màn chơi",
  "Design": "Thiết kế",
  "Play": "Chơi thử",
  "Remote Data": "Dữ liệu từ xa",
  "Map": "Bản đồ",
  "Level": "Màn chơi",
  "Customers": "Khách hàng",
  "Customer": "Khách hàng",
  "Grid": "Lưới",
  "Ingredient Queues": "Hàng đợi nguyên liệu",
  "Ingredient Queue": "Hàng đợi nguyên liệu",
  "Ingredients": "Nguyên liệu",
  "Ingredient Weights": "Trọng số nguyên liệu",
  "Dish Types": "Loại món",
  "Dish sequence": "Chuỗi món ăn",
  "Complexity": "Độ phức tạp",
  "Shuffle": "Xáo trộn",
  "Obstacles": "Chướng ngại vật",
  "Seed": "Hạt giống",
  "Weather": "Thời tiết",
  "Rainy": "Mưa",
  "Sunny": "Nắng",
  "Freeze": "Băng giá",
  "Stormy": "Bão",
  "Unlock": "Mở khóa",
  "Tag": "Nhãn",
  "None": "Không có",
  "Layout": "Bố cục",
  "Statistic": "Thống kê",
  "Statistics": "Thống kê",
  "Actions": "Thao tác",
  "Config": "Cấu hình",
  "Name": "Tên",
  "Columns": "Cột",
  "Rows": "Hàng",
  "Local": "Cục bộ",
  "Sheet data": "Dữ liệu trang tính",
  "Tool data": "Dữ liệu công cụ",
  "Sheet ID": "ID trang tính",
  "Start row": "Hàng bắt đầu",
  "Loading images…": "Đang tải hình ảnh…",
  "Computing level statistics…": "Đang tính toán thống kê màn chơi…",
  "This graph has no levels yet.": "Sơ đồ này chưa có màn chơi nào.",
  "Pick a tab above.": "Hãy chọn một thẻ ở trên.",
  "Undo": "Hoàn tác",
  "Redo": "Làm lại",
  "Save": "Lưu",
  "Save draft": "Lưu bản nháp",
  "Save Grid": "Lưu lưới",
  "Save Customers": "Lưu khách hàng",
  "Save Order": "Lưu thứ tự",
  "Unsaved": "Chưa lưu",
  "Cancel": "Hủy",
  "Close": "Đóng",
  "Clear": "Xóa",
  "Clear All": "Xóa tất cả",
  "Apply": "Áp dụng",
  "Apply changes": "Áp dụng thay đổi",
  "No changes": "Không có thay đổi",
  "Edit": "Chỉnh sửa",
  "Remove": "Xóa",
  "Delete": "Xóa",
  "Done": "Xong",
  "Copy": "Sao chép",
  "Import": "Nhập",
  "Export": "Xuất",
  "Enable All": "Bật tất cả",
  "Disable All": "Tắt tất cả",
  "Reset to defaults": "Khôi phục mặc định",
  "Restart": "Chơi lại",
  "Pause": "Tạm dừng",
  "Resume": "Tiếp tục",
  "Skip": "Bỏ qua",
  "Next": "Tiếp",
  "Prev": "Trước",
  "Give Up": "Bỏ cuộc",
  "Continue": "Tiếp tục",
  "Current": "Hiện tại",
  "Split": "Chia đôi",
  "Full": "Đầy đủ",
  "Composite": "Tổ hợp",
  "Auto": "Tự động",
  "Normal": "Thường",
  "Hard": "Khó",
  "Super Hard": "Siêu khó",
  "Light": "Sáng",
  "Dark": "Tối",
  "Fixed Value": "Giá trị cố định",
  "Curve": "Đường cong",
  "Curves": "Các đường cong",
  "Generate": "Tạo",
  "Auto Generate": "Tạo tự động",
  "Auto Generate Customers": "Tạo khách hàng tự động",
  "Auto Generate Queue": "Tạo hàng đợi tự động",
  "Auto Generate Level": "Tạo màn chơi tự động",
  "Generate until valid": "Tạo đến khi hợp lệ",
  "Random Seed": "Hạt giống ngẫu nhiên",
  "Seed (blank = pick one)": "Hạt giống (để trống = chọn ngẫu nhiên)",
  "Scoring Scenario": "Kịch bản chấm điểm",
  "Estimate Difficulty": "Ước tính độ khó",
  "Difficulty Estimate Replay": "Xem lại ước tính độ khó",
  "Replay Estimate": "Xem lại ước tính",
  "Show Recipe": "Hiện công thức",
  "Hide Recipe": "Ẩn công thức",
  "Change Avatar": "Đổi ảnh đại diện",
  "Order type": "Loại đơn",
  "Customer Dishes Sequence": "Chuỗi món của khách",
  "Generator Weights": "Trọng số bộ tạo",
  "Complexity Curve": "Đường cong độ phức tạp",
  "Shuffle Curve": "Đường cong xáo trộn",
  "Dish": "Món",
  "Queue": "Hàng đợi",
  "New string format": "Định dạng chuỗi mới",
  "Definitions": "Định nghĩa",
  "Recipe Pieces": "Thành phần công thức",
  "Recipes": "Công thức",
  "Edges": "Liên kết",
  "Option limits": "Giới hạn lựa chọn",
  "Canvas": "Khung vẽ",
  "Note": "Ghi chú",
  "Add node": "Thêm nút",
  "New map": "Bản đồ mới",
  "Auto layout": "Tự sắp xếp",
  "ID table": "Bảng ID",
  "ID table & map grid": "Bảng ID & lưới bản đồ",
  "Map grid size": "Kích thước lưới bản đồ",
  "No IDs": "Không có ID",
  "No issues.": "Không có vấn đề.",
  "No warnings for this level": "Không có cảnh báo cho màn chơi này",
  "No orderable composite yet.": "Chưa có tổ hợp nào có thể gọi món.",
  "Not addressable from level data": "Không thể tham chiếu từ dữ liệu màn chơi",
  "Mint id": "Tạo ID",
  "Select a node to edit it.": "Chọn một nút để chỉnh sửa.",
  "That node no longer exists.": "Nút đó không còn tồn tại.",
  "Refresh visual": "Làm mới hình ảnh",
  "Add slot point": "Thêm điểm vị trí",
  "New map process": "Quy trình bản đồ mới",
  "Batch generate": "Tạo hàng loạt",
  "Validate all": "Kiểm tra tất cả",
  "Validate": "Kiểm tra",
  "Delete map": "Xóa bản đồ",
  "Add Level": "Thêm màn chơi",
  "When tool is full": "Khi dụng cụ đầy",
  "Block the pick": "Chặn lượt chọn",
  "Park raw on the grid": "Đặt nguyên liệu sống lên lưới",
  "Level failed": "Màn chơi thất bại",
  "Level complete": "Hoàn thành màn chơi",
  "Use Left/Right Arrow or Prev/Next": "Dùng phím Trái/Phải hoặc Trước/Tiếp",
  "Shuffle Mode": "Chế độ xáo trộn",
  "Generated size": "Kích thước được tạo",
  "Statistic Visualize": "Hiển thị thống kê",
  "Monochromatic": "Đơn sắc",
  "Randomize": "Ngẫu nhiên",
  "Convert to New Format": "Chuyển sang định dạng mới",
  "Validate Deadlock": "Kiểm tra bế tắc",
  "Run full check": "Chạy kiểm tra đầy đủ",
  "Zoom in": "Phóng to",
  "Zoom out": "Thu nhỏ",
  "Remove Mode — click tiles to delete": "Chế độ xóa — bấm vào ô để xóa",
  "Undo All Removes": "Hoàn tác mọi thao tác xóa",
  "Sweeper": "Nhân viên dọn dẹp",
  "Shift-up Row": "Đẩy hàng lên",
  "Ingredient Pick": "Chọn nguyên liệu",
  "Clean Table": "Dọn bàn",
  "Auto Complete Dish": "Tự hoàn thành món",
  "Refill Customer Time": "Nạp lại thời gian của khách",
  "More Grid Slot": "Thêm ô lưới",
  "Uses (have / need)": "Sử dụng (có / cần)",
  "Keys (held / locks)": "Chìa khóa (có / ổ khóa)",
  "More actions": "Thêm thao tác",
  "Google Sheet access needed": "Cần quyền truy cập Google Sheet",
  "Write all graph lookup data": "Ghi toàn bộ dữ liệu tra cứu sơ đồ",
  "Load graph data": "Tải dữ liệu sơ đồ",
  "Load All from sheet": "Tải tất cả từ trang tính",
  "Apply All sheet data": "Áp dụng toàn bộ dữ liệu trang tính",
  "Apply All tool data": "Áp dụng toàn bộ dữ liệu công cụ",
  "Load All": "Tải tất cả",
  "Apply sheet data": "Áp dụng dữ liệu trang tính",
  "Apply tool data": "Áp dụng dữ liệu công cụ",
  "Load": "Tải",
  "Open in Design": "Mở trong Thiết kế",
  "Apply Sheet": "Áp dụng trang tính",
  "Apply Tool": "Áp dụng công cụ",
  "Push Remote Config": "Đẩy cấu hình từ xa",
  "Reset node draft": "Đặt lại bản nháp nút",
  "Reset node draft and reload": "Đặt lại bản nháp nút và tải lại",
  "Cook Order Game Design Tool - by daivq": "Công cụ thiết kế game Cook Order - bởi daivq",
  "Map name": "Tên bản đồ",
  "Paste a spreadsheet ID…": "Dán ID trang tính…",
  "— not set —": "— chưa đặt —",
  "— none —": "— không có —",
  "No description yet.": "Chưa có mô tả.",
  "Hover an avatar": "Di chuột lên ảnh đại diện",
  "See their name and description here.": "Xem tên và mô tả tại đây.",
  "Show pickup order": "Hiện thứ tự lấy",
  "Run Estimate Difficulty on the Customers panel first": "Hãy chạy Ước tính độ khó trong bảng Khách hàng trước",
  "Avatar unset": "Chưa đặt ảnh đại diện",
  "Customer card view": "Kiểu hiển thị thẻ khách hàng",
  "Show or hide the ingredient processing guide": "Hiện hoặc ẩn hướng dẫn chế biến nguyên liệu",
  "Switch between the light and dark theme": "Chuyển đổi giữa giao diện sáng và tối",
  "Discard every Map Process draft and reload the bundled graphs": "Xóa mọi bản nháp Quy trình bản đồ và tải lại các sơ đồ có sẵn",
  "Show/hide level, speed and tool-full settings": "Hiện/ẩn cài đặt màn chơi, tốc độ và dụng cụ đầy",
  "Add one more column to the grid.": "Thêm một cột vào lưới.",
  "Always show editable dish details": "Luôn hiện chi tiết món có thể chỉnh sửa",
  "Show packed dish slots; allow customer reordering only": "Hiện các ô món đã gom; chỉ cho phép sắp xếp lại khách hàng",
  "Compact every card while reordering customers; keep dish details while reordering dishes": "Thu gọn mọi thẻ khi sắp xếp khách; giữ chi tiết món khi sắp xếp món",
  "Customers left (vertical list) — grid + queue stacked right": "Khách hàng ở trái (danh sách dọc) — lưới và hàng đợi xếp bên phải",
  "Open the Play board and step through the most recent estimate": "Mở bàn Chơi thử và xem từng bước của lần ước tính gần nhất",
  "Fill every lane from the customer orders' ingredient demand": "Điền mọi làn theo nhu cầu nguyên liệu trong đơn của khách",
  "Append a new queue (max 5)": "Thêm hàng đợi mới (tối đa 5)",
};

const PATTERNS: Array<[RegExp, (...parts: string[]) => string]> = [
  [/^Level (\d+)$/, (n) => `Màn chơi ${n}`],
  [/^Map (\d+)$/, (n) => `Bản đồ ${n}`],
  [/^Customer (\d+)$/, (n) => `Khách hàng ${n}`],
  [/^Queue (\d+)$/, (n) => `Hàng đợi ${n}`],
  [/^(\d+) levels$/, (n) => `${n} màn chơi`],
  [/^(\d+) customers$/, (n) => `${n} khách hàng`],
  [/^(Shift-up Row|Ingredient Pick|Clean Table|Auto Complete Dish|Refill Customer Time|More Grid Slot) ×(\d+)$/,
    (label, count) => `${VIETNAMESE[label]} ×${count}`],
  [/^Level (\d+) \((Normal|Hard|Super Hard)\) — (\d+) customers$/, (level, difficulty, customers) =>
    `Màn chơi ${level} (${VIETNAMESE[difficulty]}) — ${customers} khách hàng`],
  [/^Level (\d+) \((Normal|Hard|Super Hard)\)$/, (level, difficulty) =>
    `Màn chơi ${level} (${VIETNAMESE[difficulty]})`],
  [/^Level (\d+) — (\d+) customers$/, (level, customers) =>
    `Màn chơi ${level} — ${customers} khách hàng`],
  [/^Map (\d+) — (.+) · committed level dataset$/, (map, name) =>
    `Bản đồ ${map} — ${name} · bộ dữ liệu màn chơi đã lưu`],
  [/^Map (\d+) — (.+)$/, (map, name) => `Bản đồ ${map} — ${name}`],
];

const textSources = new WeakMap<Text, { source: string; output: string }>();
const attributeSources = new WeakMap<Element, Map<string, { source: string; output: string }>>();
let language: Language = "en";
let observer: MutationObserver | undefined;

export function translateText(input: string, target: Language = language): string {
  if (target === "en" || !input.trim()) return input;
  const leading = input.match(/^\s*/)?.[0] ?? "";
  const trailing = input.match(/\s*$/)?.[0] ?? "";
  let core = input.slice(leading.length, input.length - trailing.length);
  const icon = core.match(/^([^\p{L}\p{N}]*)(.+)$/u);
  const prefix = icon?.[1] ?? "";
  const phrase = icon?.[2] ?? core;
  let translated = VIETNAMESE[phrase];
  if (!translated) {
    for (const [pattern, replace] of PATTERNS) {
      const match = phrase.match(pattern);
      if (match) {
        translated = replace(...match.slice(1));
        break;
      }
    }
  }
  core = translated ? `${prefix}${translated}` : core;
  return `${leading}${core}${trailing}`;
}

export function loadLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "vi") return stored;
  } catch {
    // Storage can be disabled; English remains the stable default.
  }
  return "en";
}

export function saveLanguage(next: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch (err) {
    console.warn("Could not persist the language choice", err);
  }
}

function localizeTextNode(node: Text): void {
  const current = node.data;
  const remembered = textSources.get(node);
  const source = remembered && current === remembered.output ? remembered.source : current;
  const output = translateText(source);
  textSources.set(node, { source, output });
  if (current !== output) node.data = output;
}

function localizeAttribute(element: Element, name: string): void {
  const current = element.getAttribute(name);
  if (current === null) return;
  let attributes = attributeSources.get(element);
  if (!attributes) {
    attributes = new Map();
    attributeSources.set(element, attributes);
  }
  const remembered = attributes.get(name);
  const source = remembered && current === remembered.output ? remembered.source : current;
  const output = translateText(source);
  attributes.set(name, { source, output });
  if (current !== output) element.setAttribute(name, output);
}

export function localizeTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  if (root instanceof Element) {
    for (const name of ["title", "placeholder", "aria-label"]) localizeAttribute(root, name);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.TEXT_NODE) localizeTextNode(current as Text);
    else {
      const element = current as Element;
      for (const name of ["title", "placeholder", "aria-label"]) localizeAttribute(element, name);
    }
  }
}

export function applyLanguage(next: Language): void {
  language = next;
  document.documentElement.lang = next;
  document.title = next === "vi" ? "CookOrder — Công cụ thiết kế màn chơi" : "CookOrder — Level Design Tool";
  localizeTree(document.documentElement);
}

export function installLanguageObserver(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        localizeAttribute(mutation.target as Element, mutation.attributeName!);
      } else {
        for (const node of mutation.addedNodes) localizeTree(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title", "placeholder", "aria-label"],
  });
}

export const otherLanguage = (value: Language): Language => (value === "en" ? "vi" : "en");

export function languageToggleLabel(value: Language): string {
  return value === "en" ? "🇻🇳 VI" : "🇬🇧 EN";
}

export function languageToggleTitle(value: Language): string {
  return value === "en" ? "Chuyển sang tiếng Việt" : "Switch to English";
}
