/* Runs the actual content controller against a synthetic six-step website. */
const scenario=new URL(location.href).searchParams.get('scenario')||'flow';
const fixture=document.getElementById('fixture');
const summary='<div id="details_infobox"><ul id="info_box_cnc_list"><li>1 Mal RWTH Studenten</li></ul>Ausländeramt Aachen - Außenstelle RWTH</div>';
let step=2, finalClicks=0, waits=0, listener, actions=[], chosen, submittedAt;
const automatic=scenario.startsWith('auto'), grid=/grid|direct/.test(scenario);
const config={...structuredClone(TerminCore.DEFAULTS),autoSubmit:automatic,eligible:true,weekdays:[0,1,2,3,4,5,6],profile:{...TerminCore.DEFAULTS.profile,firstName:'Test',lastName:'User',email:'test@example.org'}};
function render(body){const info=chosen?summary.replace('</div>',`<dl><dt>Termin</dt><dd>${chosen.date} ${chosen.time} Uhr</dd><dt>Persönliche Daten</dt><dd>Test User test@example.org</dd></dl></div>`):summary;fixture.innerHTML=`<main id="inhalt"><h1>Schritt ${step} von 6</h1>${step>=3?info:''}${body}</main>`;}
function result(ok,message){document.getElementById('test-result').textContent=(ok?'PASS':'FAIL')+' · '+message;document.documentElement.dataset.testResult=ok?'passed':'failed';}
function formPage(){step=5;render('<form><label>Vorname<input name="vorname" required></label><label>Nachname<input name="nachname" required></label><label>E-Mail<input name="email" type="email" required></label>'+(scenario==='required'?'<label>Aktenzeichen<input name="aktenzeichen" required></label>':'')+(scenario==='auto-direct'?'<button id="final" type="submit">Termin vereinbaren</button>':'<button id="WeiterButton" type="submit">Weiter</button>')+'</form>');}
globalThis.chrome={runtime:{
  onMessage:{addListener:fn=>{listener=fn;}},
  sendMessage:async message=>{
    if(message.type==='READY') return {ok:true,active:true,config,runId:'integration'};
    if(message.type==='ACTION'){actions.push(message.message);if(message.slot)chosen=message.slot;return {ok:true,active:true};}
    if(message.type==='SUBMIT'){if(submittedAt)return {ok:false,active:false};submittedAt=Date.now();return {ok:true,active:true,submittedAt};}
    if(message.type==='DONE'){result(automatic&&finalClicks===1&&!!submittedAt,`automatic booking (${scenario}): ${finalClicks} final submission, success observed`);return {ok:true};}
    if(message.type==='WAIT'){
      waits++;
      // A changing session clock must not postpone the alarm by sending WAIT repeatedly.
      setTimeout(()=>fixture.append(document.createTextNode(' session clock changed')),30);
      setTimeout(()=>listener({type:'CAN_RELOAD'},{},res=>result(res.safe&&waits===1,`waiting controller: ${waits} WAIT, safe reload=${res.safe}`)),1200);
      return {ok:true,active:true};
    }
    if(message.type==='HUMAN_WAIT'){
      if(scenario==='required') result(step===5&&fixture.querySelector('[name="vorname"]').value==='Test'&&message.message.includes('Aktenzeichen'),'known fields filled; unknown required field waits without stopping the controller');
      else result(false,'unexpected manual wait: '+message.message);
      return {ok:true,active:true};
    }
    if(message.type==='HANDOFF'){
      if(automatic){result(false,message.message);return {ok:true};}
      const fields=[...fixture.querySelectorAll('input')];
      if(scenario==='required') result(step===5&&fields.find(x=>x.name==='vorname').value==='Test'&&message.message.includes('Aktenzeichen'),'unknown required field triggers handoff after filling known fields');
      else result(step===6&&finalClicks===0&&actions.length===(grid?7:8),`six-step controller (${scenario}): ${actions.length} actions, ${finalClicks} final submissions`);
      return {ok:true};
    }
    return {ok:true};
  }
}};
document.addEventListener('click',event=>{
  const el=event.target;
  if(step===4&&el.matches('form.suggestion_form .suggest_btn')){event.preventDefault();if(el.textContent!=='08:30'){result(false,'wrong calendar tile selected');return;}formPage();return;}
  if(el.id==='plus'){fixture.querySelector('input').value='1';return;}
  if(el.id==='OKButton'){step=3;render('<form><button id="WeiterButton" type="submit">Weiter</button></form>');return;}
  if(el.id==='final'){finalClicks++;event.preventDefault();if(automatic){step=6;render('Ihr Termin wurde erfolgreich gebucht.');}return;}
  if(el.id!=='WeiterButton')return;
  event.preventDefault();
  if(step===2){fixture.insertAdjacentHTML('beforeend','<div id="TevisDialog"><h3>Anliegen: RWTH Studenten</h3><button id="OKButton">OK</button></div>');}
  else if(step===3){step=4;render(grid
    ? '<details id="details_suggest_times" open><summary id="suggest_details_summary">Mittwoch, 11.11.2099</summary><div class="suggest_details_panel"><table class="sugg_table"><tbody><tr><th>08:00 - 09:00</th><td><button class="suggest_btn" type="button" disabled>08:00</button></td><td><form class="suggestion_form" method="post"><input type="hidden" name="start"><input type="hidden" name="checksum"><button type="submit" class="suggest_btn" title="08:30">08:30</button></form></td><td><form class="suggestion_form" method="post"><button type="submit" class="suggest_btn" title="08:45">08:45</button></form></td></tr></tbody></table></div></details>'
    : '<form><div id="sugg_accordion"><section><h3>04.11.2099</h3><label><input type="radio" id="late" name="slot">08:00 Uhr</label></section><section><h3>02.11.2099</h3><label><input type="radio" id="early" name="slot">09:00 Uhr</label></section></div><button id="WeiterButton" type="submit">Weiter</button></form>');}
  else if(step===4){if(!fixture.querySelector('#early').checked){result(false,'earliest slot not selected');return;}formPage();}
  else if(step===5){
    if(fixture.querySelector('[name="vorname"]').value!=='Test'||fixture.querySelector('[name="email"]').value!=='test@example.org'){result(false,'autofill failed');return;}
    step=6;render('<form><button id="final" type="submit">Termin verbindlich buchen</button></form>');
  }
});
document.addEventListener('submit',event=>event.preventDefault());
if(scenario==='waiting'){step=4;render('<h2>Kein freier Termin verfügbar</h2>');}
else if(scenario==='required')formPage();
else render('<form><input class="cnc-number" name="cnc-344" data-tevis-cncname="RWTH Studenten" type="number" value="0"><button id="plus" type="button" data-type="plus" data-field="cnc-344">+</button><button id="WeiterButton" type="submit">Weiter</button></form>');
