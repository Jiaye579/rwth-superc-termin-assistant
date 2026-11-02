/* Actual content.js + sanitized observed form. No connection to the authority. */
const scenario = new URL(location.href).searchParams.get('scenario') || 'auto';
const fixture = document.getElementById('fixture');
const chosen = {date:'2099-11-11',time:'09:00'};
const config = {...structuredClone(TerminCore.DEFAULTS),eligible:true,autoSubmit:true,weekdays:[0,1,2,3,4,5,6],profile:{...TerminCore.DEFAULTS.profile,firstName:'Test',lastName:'User',email:'test@example.org',phone:'+49123456789',birthDate:'2001-02-03'}};
const automaticModal = scenario.startsWith('auto-modal');
let listener, finalClicks=0, submittedAt, waits=0, modalClicks=0, exercising=false, failure, modalPending=automaticModal, modalPermit=false;
const assertions=[];
function check(ok,message){if(!ok){failure=message;result(false,message);throw new Error(message);}assertions.push(message);}
function result(ok,message){document.getElementById('test-result').textContent=(ok?'PASS':'FAIL')+' · '+message;document.documentElement.dataset.testResult=ok?'passed':'failed';}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let formHTML;
const ready=Promise.all(['superc-personaldata.html','slot-confirm-dialog.html'].map(file=>fetch('fixtures/'+file).then(r=>r.text()))).then(([html,modalHTML])=>{
  formHTML=html.replaceAll('11.11.2026','11.11.2099');
  if(automaticModal) {
    fixture.innerHTML='<main id="inhalt"><h1>Schritt 4 von 6</h1><div id="details_infobox">RWTH Studenten · Außenstelle RWTH<dl><dt>Termin</dt><dd>11.11.2099, 09:00 Uhr</dd></dl></div>'+modalHTML+'</main>';
    if(scenario==='auto-modal-reversed') {const left=fixture.querySelector('#slot-dialog-left'),right=fixture.querySelector('#slot-dialog-right');left.style.order='1';right.style.order='2';fixture.querySelector('.modal-footer').replaceChildren(right,left);}
  }
  else if(scenario==='modal') fixture.innerHTML='<main id="inhalt"><h1>Schritt 4 von 6</h1><div id="details_infobox">RWTH Studenten · Außenstelle RWTH<dl><dt>Termin</dt><dd>11.11.2099, 09:00 Uhr</dd></dl></div><div id="TevisDialog" role="dialog"><p>Unbekannter Hinweis</p><button type="button" id="modal-back">Zurück</button><button type="button" id="modal-next">Weiter</button></div></main>';
  else fixture.innerHTML=formHTML;
});
async function exercise(){
  if(exercising)return;exercising=true;
  try {
    await delay(600);
    if(scenario==='auto-modal-stuck') {
      check(modalPermit&&modalClicks===1&&!modalPending,'spatial confirm consumes its permit before the only click');
      await delay(1000);check(modalClicks===1&&finalClicks===0,'unchanged dialog is not clicked repeatedly');
      result(!failure,'stuck automatic dialog clicked once, then waits and keeps diagnostics');return;
    }
    if(scenario==='modal') {
      check(modalClicks===0,'unknown two-button modal is not auto-accepted');
      check(finalClicks===0,'no submit while unknown modal is open');
      fixture.querySelector('#modal-next').click();
      await delay(900);
    }
    if(automaticModal) check(modalClicks===1&&modalPermit,'right blue footer button automatically continued into the form');
    check(fixture.querySelector('#vorname').value==='Test','first name already filled before CAPTCHA');
    check(fixture.querySelector('#emailwhlg').value===config.profile.email,'repeated email filled');
    check(fixture.querySelector('#geburtsdatumDay').value==='3'&&fixture.querySelector('#geburtsdatumMonth').value==='2'&&fixture.querySelector('#geburtsdatumYear').value==='2001','split birth date filled');
    const diagnostic=await new Promise(resolve=>listener({type:'GET_DIAGNOSTIC'},{},resolve));
    check(diagnostic.diagnostic.step===5&&!JSON.stringify(diagnostic).includes(config.profile.email),'diagnostic retains structure without entered email');
    const captcha=fixture.querySelector('#captcha_result'),consent=fixture.querySelector('[name="agreementChecked"]');
    check(captcha.value===''&&!consent.checked,'CAPTCHA and agreement are left to the person');
    if(scenario==='identity') {fixture.querySelector('#vorname').value='Corrected';fixture.querySelector('#vorname').dispatchEvent(new Event('input',{bubbles:true}));}
    fixture.querySelector('#phone').value='+49987654321';
    consent.checked=true;consent.dispatchEvent(new Event('change',{bubbles:true}));
    captcha.focus();captcha.value='X';captcha.dispatchEvent(new Event('input',{bubbles:true}));
    await delay(900);
    check(finalClicks===0&&!submittedAt,'first CAPTCHA character never submits while editing');
    check(fixture.querySelector('#phone').value==='+49987654321','waiting never overwrites a user correction');
    captcha.value='LOCAL-TEST';captcha.dispatchEvent(new Event('input',{bubbles:true}));
    await delay(700);check(finalClicks===0,'completed text still waits until focus leaves CAPTCHA');
    captcha.dispatchEvent(new Event('change',{bubbles:true}));fixture.querySelector('#comment').focus();
  } catch(error) {result(false,error.message);}
}
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async message=>{
  if(message.type==='READY'){await ready;return {ok:true,active:true,config,runId:'real-form-integration',selected:chosen,awaitingSlotDialog:modalPending,slotDialogArmed:automaticModal};}
  if(message.type==='ACTION') {
    if(message.slotDialog){if(!modalPending||JSON.stringify(message.dialogSlot)!==JSON.stringify(chosen))return {ok:false,active:true};modalPending=false;modalPermit=true;}
    if(message.formReady)modalPending=false;
    return {ok:true,active:true,awaitingSlotDialog:modalPending,slotDialogArmed:automaticModal};
  }
  if(message.type==='HUMAN_WAIT'){waits++;void exercise();return {ok:true,active:true};}
  if(message.type==='SUBMIT'){if(submittedAt)return {ok:false,active:false};submittedAt=Date.now();return {ok:true,active:true,submittedAt};}
  if(message.type==='DONE'){result(!failure&&scenario!=='identity'&&finalClicks===1&&!!submittedAt,`${scenario}: ${finalClicks} final submission; ${assertions.length} checks; resumed after human input`);return {ok:true};}
  if(message.type==='HANDOFF'){result(!failure&&scenario==='identity'&&finalClicks===0&&!submittedAt&&fixture.querySelector('#vorname')?.value==='Corrected'&&/姓名或邮箱/.test(message.message),'edited identity is preserved and rejected before automatic submission');return {ok:true};}
  return {ok:true};
}}};
document.addEventListener('click',event=>{
  if(event.target.id==='modal-next'){modalClicks++;fixture.innerHTML=formHTML;}
  if(event.target.closest('#slot-dialog-right')){if(!modalPermit){result(false,'dialog clicked before one-use permit was recorded');return;}modalClicks++;if(scenario!=='auto-modal-stuck')fixture.innerHTML=formHTML;}
  if(event.target.closest('#slot-dialog-left'))result(false,'left dialog button clicked');
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.id!=='cal-reservation')return;
  finalClicks++;
  if(!submittedAt){result(false,'final click occurred before durable SUBMIT permission');return;}
  fixture.innerHTML='<main id="inhalt"><h1>Schritt 6 von 6</h1><p>Bitte bestätigen Sie Ihre E-Mail über den Bestätigungslink.</p></main>';
});
setTimeout(()=>{if(!document.documentElement.dataset.testResult)result(false,'controller did not finish within 12 seconds');},12000);
