/// Plain English words that are also plausible dictionary entries (BUS-138).
/// A dictionary entry made only of one of these words (Will, Sky, Mark, Bill,
/// May, IT...) is never used to rewrite the transcript: forcing "Will" would
/// recapitalise every "will" the user says. Names and brands that are not
/// everyday words (Skyloom, Voxloom, Café) are not listed and are fixed.
///
/// Small on purpose: the most frequent English words plus common words that
/// double as names. A word missing here is simply fixed like any other entry.
const COMMON_WORDS = `
a about above across act add after again against age ago agree air all allow
almost alone along already also always am among an and amber angel another answer any
anyone anything apple april are area arm around art as ask at august aunt away
back bad bank bar base bay be bear beat because become bed been before began
begin behind being believe bell below best better between big bill bird bit
black blue board boat body bone book born both bow box boy break bring brother
brown build burn but buy by call came can car care carry case cat catch cause
chance change charge check child chip choose church city class clay clear close
cloud club coach cold come common cook cool copy corn could count country course
cover cross cut dad dance dark date dawn day dead deal dean dear deep did die
different do doctor dog done door down draw dream drive drop dry during each
ear early earth east eat edge else end enough even evening ever every example eye
face faith fall family far farm fast father few field fight find fine fire first
fish five fix floor fly follow food foot for force forest form found four free
friend frank from front full fun game gave general get girl give glad glass go
gold gone good got grace grand grant grass gray great green grew ground group
grow guess guy had hair half hall hand happen happy hard has hat have he head
hear heart heat held help her here high hill him his hold hole home hope horse
hot hour house how however hundred hunt i ice idea if in inch into iron is island
it its jack jade jam jay job join joy july jump june just keep kept key kid kind
king knew know lady lake land large last late laugh lay lead learn least leave
left leg less let letter life light like line list listen little live long look
lot love low luck made make man many map march mark mary master matter may maybe
me mean meet men might mile mind mine miss moon more morning most mother mount
mouth move much music must my name near need never new next nice night no none
noon north nose not note nothing now number of off often oil old on once one only
open or order other our out over own page paper part pass past pat pay pearl
people person pick piece pine place plan plant play point pool poor pop power
press pretty pull put queen question quick quiet race rain ran rate reach read
ready real red rest rich ride right ring rise river road rock rod roll room rose
round row run safe said sail same sand sat save saw say school sea second see seed
seem sell send sense sent set seven shall shape she ship shop short should show
side sign simple since sing sister sit six size skin sky sleep slow small smile snow
so soft some son song soon sort sound south space speak spring square stand star
start state stay step still stone stop store story street strong study such summer
sun sure swim table take talk tall teach tell ten than thank that the their them
then there these they thing think third this those though thought three through
time to today together told tom too took top touch town toy tree true try turn two
under until up upon us use usual very voice wait walk wall want war warm was wash
watch water wave way we wear week well went were west what wheel when where which
while white who whole whose why wide wife wild will win wind wing winter wish with
within without woman wonder wood word work world would write wrong yard year yes
yet you young your
chase ray sue bob
`;

const WORDS: ReadonlySet<string> = new Set(COMMON_WORDS.split(/\s+/u).filter(Boolean));

export function isCommonWord(word: string): boolean {
  return WORDS.has(word.toLowerCase());
}
