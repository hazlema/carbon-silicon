import {Battlefield} from './scene';
import {isCheckersCommand, type CheckersView, type CheckersCommand} from '@cs/checkers';
import {boardMarkup} from './board-template';
import {TurnSelection} from './selection';
import type {Side} from '@cs/checkers/rules';
export interface BoardProps {
 view: CheckersView;
 legal: unknown[];
 interactive: boolean;
 onMove: (command: CheckersCommand) => void | Promise<void>;
 /** Who commands each army; the house names stand in for anyone missing. */
 players?: Partial<Record<Side, {name: string; note?: string}>>;
}
export interface BoardOptions {
 /** URL of the supplied style.css, served by the host. */
 stylesheetUrl?: string;
 /** URL of the original citadel background, served by the host. */
 backdropUrl?: string;
}
/** No match transport: the host supplies updates and handles move submissions. */
export function mountCheckers(host: HTMLElement, initial: BoardProps, options: BoardOptions = {}) {
 const root=host.shadowRoot??host.attachShadow({mode:'open'});
 const style=document.createElement('link');style.rel='stylesheet';style.href=options.stylesheetUrl??'/style.css';
 const wrapper=document.createElement('div');wrapper.className='board-root';wrapper.innerHTML=boardMarkup;
 if(options.backdropUrl)wrapper.style.setProperty('--crown-backdrop', `url(${JSON.stringify(options.backdropUrl)})`);
 root.replaceChildren(style,wrapper);
 const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector(`#${id}`) as T;
 let props=initial,destroyed=false;
 const selection=new TurnSelection();
 let state: {game:CheckersView; moves:CheckersCommand[]}|null=null,selected:string|null=null,busy=false,sound=false;
 try{sound=localStorage.getItem('crown_sound')==='on';}catch{/* Storage is optional. */}
let field:Battlefield|undefined;
let toastTimer:ReturnType<typeof setTimeout>;
function toast(message:string){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
let audio:AudioContext|undefined,noise:AudioBuffer|undefined;
function soundContext(){if(!sound)return;try{audio??=new AudioContext();void audio.resume();return audio;}catch{return;/* Sound is optional. */}}
function noiseBuffer(a:AudioContext){if(!noise){noise=a.createBuffer(1,Math.floor(a.sampleRate*.3),a.sampleRate);const data=noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;}return noise;}
/** A piece sliding over stone: a short burst of noise swept down through a lowpass. */
function playSlide(delay=0){const a=soundContext();if(!a)return;const t=a.currentTime+delay;const src=a.createBufferSource();src.buffer=noiseBuffer(a);const filter=a.createBiquadFilter();filter.type='lowpass';filter.frequency.setValueAtTime(900,t);filter.frequency.exponentialRampToValueAtTime(220,t+.14);const gain=a.createGain();gain.gain.setValueAtTime(.15,t);gain.gain.exponentialRampToValueAtTime(.001,t+.15);src.connect(filter);filter.connect(gain);gain.connect(a.destination);src.start(t);src.stop(t+.16);}
/** A heavy landing: low sine dropping fast, with a click of muffled noise at the front. */
function playThud(delay=0){const a=soundContext();if(!a)return;const t=a.currentTime+delay;const osc=a.createOscillator(),gain=a.createGain();osc.type='sine';osc.frequency.setValueAtTime(120,t);osc.frequency.exponentialRampToValueAtTime(40,t+.15);gain.gain.setValueAtTime(.3,t);gain.gain.exponentialRampToValueAtTime(.001,t+.2);osc.connect(gain);gain.connect(a.destination);osc.start(t);osc.stop(t+.21);const click=a.createBufferSource();click.buffer=noiseBuffer(a);const filter=a.createBiquadFilter();filter.type='lowpass';filter.frequency.value=350;const clickGain=a.createGain();clickGain.gain.setValueAtTime(.17,t);clickGain.gain.exponentialRampToValueAtTime(.001,t+.05);click.connect(filter);filter.connect(clickGain);clickGain.connect(a.destination);click.start(t);click.stop(t+.06);}
/** A small metallic ting for a coronation. */
function playTing(delay=0){const a=soundContext();if(!a)return;const t=a.currentTime+delay;for(const [freq,vol] of [[1319,.1],[1976,.06]] as const){const osc=a.createOscillator(),gain=a.createGain();osc.type='sine';osc.frequency.value=freq;gain.gain.setValueAtTime(vol,t);gain.gain.exponentialRampToValueAtTime(.001,t+.4);osc.connect(gain);gain.connect(a.destination);osc.start(t);osc.stop(t+.41);}}
function playVerdictSound(kind:'won'|'lost'|'draw'|'neutral'){const a=soundContext();if(!a)return;const notes:readonly (readonly [number,number])[]=kind==='lost'?[[330,0],[262,.28]]:kind==='draw'?[[440,0],[440,.25]]:[[392,0],[523,.13],[659,.26]];for(const [freq,at] of notes){const t=a.currentTime+at;const osc=a.createOscillator(),gain=a.createGain();osc.type='triangle';osc.frequency.value=freq;gain.gain.setValueAtTime(.14,t);gain.gain.exponentialRampToValueAtTime(.001,t+.35);osc.connect(gain);gain.connect(a.destination);osc.start(t);osc.stop(t+.36);}}
const house=(side:Side)=>side==='red'?'House Ember':'House Azure';
/** The commander's name when the host supplied one, else the house's. */
const title=(side:Side)=>props.players?.[side]?.name??house(side);
function canPlay(){return !!state&&props.interactive&&!busy&&!state.game.winner;}
async function move(command:CheckersCommand){
 if(!canPlay()||!state||!state.moves.includes(command))return;
 busy=true;
 try{render();await props.onMove(command);}catch(error){if(!destroyed)toast((error as Error).message);}
 finally{busy=false;selection.reset();selected=null;if(!destroyed)render();}
}
function choose(square:string){
 if(!canPlay()||!state)return;
 const command=selection.choose(square);
 selected=selection.selected;
 if(command){void move(command);return;}
 render();
}
try{field=new Battlefield($('battlefield'),choose);$('loading').remove();}catch(error){$('loading').className='webgl-error';$('loading').textContent='3D rendering is unavailable in this browser. You can still play using the coordinate controls below.';$('keyboard-moves').hidden=false;console.error(error);}
let facing:Side|undefined;
function receive(next:BoardProps){
 const old=state;
 // Players see from behind their own army; spectators keep red's view. Set once per side, so a manual
 // rotation survives every later update.
 const side=next.view.you??'red';
 if(side!==facing){facing=side;field?.face(side);}
 props=next;
 const moves=next.legal.filter(isCheckersCommand);
 state={game:next.view,moves};
 selection.update(moves,next.interactive&&!next.view.winner,next.view.revision);
 selected=selection.selected;
 if(old&&next.view.history.length>old.game.history.length){
  next.view.history.slice(old.game.history.length).forEach((entry,i)=>{
   if(entry.capture)playThud(i*.13);else playSlide(i*.13);
   if(entry.crowned)playTing(i*.13+.12);
  });
 }
 if(old&&!old.game.winner&&next.view.winner)showVerdict(next.view.winner);
 if(!next.view.winner)$<HTMLDialogElement>('verdict-dialog').close();
 render();
}
function showVerdict(winner:Side|'draw'){
 if(!state)return;
 const humans=state.game.you?[state.game.you]:[];
 const emblem=$('verdict-emblem');emblem.classList.remove('red','blue','draw');
 if(winner==='draw'){
  emblem.textContent='⚐';emblem.classList.add('draw');
  $('verdict-eyebrow').textContent='The parley holds';
  $('verdict-title').textContent='An honorable draw.';
  $('verdict-text').textContent='The houses lower their blades and share the field. The chronicle remembers both with honor.';
  playVerdictSound('draw');
 }else{
  const won=humans.length===1&&humans[0]===winner,lost=humans.length===1&&humans[0]!==winner;
  emblem.textContent='♛';emblem.classList.add(winner);
  $('verdict-eyebrow').textContent='The chronicle records';
  $('verdict-title').textContent=won?'Victory!':lost?'Defeat.':`${title(winner)} claims the crown.`;
  $('verdict-text').textContent=won?`${title(winner)} claims the crown. The field is yours, commander — the bards will sing of this.`:lost?`${title(winner)} claims the crown. Your army fought to the last knight. Raise the banners and answer.`:'The battle is decided. Raise the armies to contest the throne again.';
  playVerdictSound(won?'won':lost?'lost':'neutral');
 }
 $<HTMLDialogElement>('verdict-dialog').showModal();
}
function render(){
 if(!state)return;const {game,moves}=state;
 for(const side of ['red','blue'] as Side[]){
  const pieces=game.pieces.filter(p=>p.side===side);$(`${side}-count`).textContent=String(pieces.length);$(`${side}-kings`).textContent=String(pieces.filter(p=>p.king).length);
  $(`${side}-card`).classList.toggle('active',game.turn===side&&!game.winner);
  $(`${side}-name`).textContent=title(side);
  $(`${side}-role`).textContent=[house(side),game.you===side?'you':props.players?.[side]?.note].filter(Boolean).join(' · ');
 }
 $('turn-title').textContent=game.winner?(game.winner==='draw'?'An honorable stalemate.':`${title(game.winner)} claims the crown.`):`${title(game.turn)}, ${canPlay()?'your move.':'awaiting orders.'}`;
 $('turn-help').textContent=game.winner?'The battle is decided.':!props.interactive?(game.you===null?'Watching the battlefield.':'Waiting for the opposing army.'):selection.path.length>1?'Continue the highlighted charge. The full turn will be submitted together.':selected?`${selected.toUpperCase()} selected. Choose a gold destination.`:'Select a knight to see where it can march.';
 root.querySelector('.ck-stack')!.classList.toggle('is-blue',game.turn==='blue');
 $('turn-number').textContent=String(game.moveCount+1).padStart(2,'0');
 $('round-label').textContent=game.history.length?`${game.history.length} ${game.history.length===1?'march':'marches'} made`:'Opening formation';
 $('history-count').textContent=`${game.history.length} move${game.history.length===1?'':'s'}`;
 const marchText=(entry:CheckersView['history'][number])=>`${entry.from} ${entry.capture?'×':'→'} ${entry.to}${entry.crowned?' ♛':''}`;
 const strip=$('chronicle-strip');
 if(game.history.length){strip.replaceChildren(...game.history.slice(-6).reverse().map(entry=>{const item=document.createElement('li');item.className=`strip-march ${entry.side}`;const number=document.createElement('span');number.className='move-number';number.textContent=String(entry.number).padStart(2,'0');item.append(number,` ${marchText(entry)}`);return item;}));}
 else if(strip.querySelector('.strip-march')){strip.innerHTML='<li class="strip-empty">History awaits.</li>';}
 const history=$('history-list');
 if(game.history.length){history.replaceChildren(...game.history.slice().reverse().map(entry=>{const row=document.createElement('div');row.className='history-row';const number=document.createElement('span');number.className='move-number';number.textContent=String(entry.number).padStart(2,'0');const text=document.createElement('span');text.className='move-text';text.textContent=marchText(entry);const side=document.createElement('span');side.className=`move-side ${entry.side}`;side.textContent=entry.side==='red'?'Red':'Blue';row.append(number,text,side);return row;}));}else if(history.querySelector('.history-row')){history.innerHTML='<div class="empty-chronicle"><h3>History awaits.</h3><p>The first march writes<br>the first line.</p></div>';}
 const selector=$<HTMLSelectElement>('move-select'),oldValue=selector.value;
 selector.replaceChildren(...moves.map((m,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=m.steps.join(' → ');return option;}));
 if(oldValue!==''&&Number(oldValue)<moves.length)selector.value=oldValue;
 selector.disabled=!canPlay();$<HTMLButtonElement>('play-selected').disabled=!canPlay();
 field?.update(selection.preview(game),selected,canPlay()?selection.hints():[]);
}
$('rotate').onclick=()=>field?.rotate();$('zoom-in').onclick=()=>field?.changeZoom(.1);$('zoom-out').onclick=()=>field?.changeZoom(-.1);
function syncSoundButton(){$('sound').setAttribute('aria-pressed',String(sound));$('sound').setAttribute('aria-label',sound?'Disable sound':'Enable sound');$('sound').title=sound?'Disable sound':'Enable sound';}
syncSoundButton();
$('sound').onclick=()=>{sound=!sound;try{localStorage.setItem('crown_sound',sound?'on':'off');}catch{/* Storage is optional. */}syncSoundButton();playSlide();};
$('keyboard-toggle').onclick=()=>{$('keyboard-moves').hidden=!$('keyboard-moves').hidden;if(!$('keyboard-moves').hidden)$('move-select').focus();};
$('play-selected').onclick=()=>{const command=state?.moves[Number($<HTMLSelectElement>('move-select').value)];if(command)void move(command);};
function openDialog(id:string){$<HTMLDialogElement>(id).showModal();}
$('rules-open').onclick=()=>openDialog('rules-dialog');
$('chronicle-open').onclick=()=>openDialog('chronicle-dialog');
for(const dialog of root.querySelectorAll('dialog')){for(const close of dialog.querySelectorAll('.dialog-close,.close-dialog'))close.addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();}});}
receive(initial);
return {
 update(next:BoardProps){if(!destroyed)receive(next);},
 destroy(){
  if(destroyed)return;destroyed=true;
  clearTimeout(toastTimer);field?.destroy();void audio?.close();
  for(const dialog of root.querySelectorAll('dialog'))dialog.close();
  root.replaceChildren();
 },
};
}
