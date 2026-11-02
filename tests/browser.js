(async function () {
const C = TerminCore, A = TerminAdapter;
const fixture = document.getElementById('fixture');
const config = {...structuredClone(C.DEFAULTS), autoSubmit:false, eligible:true,profile:{...C.DEFAULTS.profile,firstName:'Test',lastName:'User',email:'test@example.org',birthDate:'2001-02-03'}};
const summary = '<div id="details_infobox"><ul id="info_box_cnc_list"><li>1 Mal RWTH Studenten</li></ul>Ausländeramt Aachen - Außenstelle RWTH</div>';
let passed = 0, failed = 0;
function page(step, body, extra = summary) { fixture.innerHTML = `<main id="inhalt"><h1>Schritt ${step} von 6</h1>${extra}${body}</main>`; }
// Pass a document-like facade so the test runner's own h1 is not part of the appointment DOM.
const doc = {querySelector:q=>fixture.querySelector(q),querySelectorAll:q=>fixture.querySelectorAll(q),getElementById:id=>fixture.querySelector('#'+id),get body(){return fixture;}};
function equal(a,b) {if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);}
function test(name, fn) {const li=document.createElement('li');try{fn();passed++;li.className='pass';li.textContent='PASS · '+name;}catch(e){failed++;li.className='fail';li.textContent='FAIL · '+name+' · '+e.message;}document.getElementById('results').append(li);}
test('真实当前编号之外的新编号仍按服务名称识别',()=>{
  page(2,'<form><input class="cnc-number" name="cnc-999" data-tevis-cncname="RWTH Studenten" type="number" value="0"><button id="plus" type="button" data-type="plus" data-field="cnc-999">+</button></form>','');
  equal(A.inspect(doc,config).el.id,'plus');
});
test('分类折叠时先展开而不点击隐藏控件',()=>{
  page(2,'<h3 id="student-header" role="tab">RWTH - Außenstelle Super C</h3><div role="tabpanel" aria-hidden="true" aria-labelledby="student-header"><input class="cnc-number" data-tevis-cncname="RWTH Studenten" type="number" value="0"></div>','');
  equal(A.inspect(doc,config).el.id,'student-header');
});
test('额外选中家庭成员时停止',()=>{
  page(2,'<input class="cnc-number" data-tevis-cncname="RWTH Studenten" type="number" value="1"><input class="cnc-number" data-tevis-cncname="RWTH Familienangehörige" type="number" value="1">','');
  equal(A.inspect(doc,config).kind,'pause');
});
test('没有空位时进入等待',()=>{page(4,'<h2>Kein freier Termin verfügbar</h2>');equal(A.inspect(doc,config).kind,'watch');});
test('未知页面结构停止，不能误报没有空位',()=>{page(4,'<h2>Something changed</h2>');equal(A.inspect(doc,config).kind,'pause');});
test('选错地点时停止',()=>{page(4,'<h2>Kein freier Termin verfügbar</h2>','<div id="details_infobox">FH Studenten</div>');equal(A.inspect(doc,config).kind,'pause');});
test('多个日期和时间按德国当地日期排序',()=>{
  page(4,'<div id="sugg_accordion"><section><h3>04.11.2099</h3><label><input type="radio" name="slot" id="late">08:00 Uhr</label></section><section><h3>02.11.2099</h3><label><input type="radio" name="slot" id="early">09:00 Uhr</label><label><input type="radio" name="slot" id="later-time">10:00 Uhr</label></section></div><button id="WeiterButton">Weiter</button>');
  const plan=A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]}); equal(plan.el.id,'early');equal(plan.slot,{date:'2099-11-02',time:'09:00'});
});
test('已经勾选最早时间时只进入下一步',()=>{fixture.querySelector('#early').checked=true;equal(A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]}).kind,'slot-next');});
test('不符合日期条件的空位继续等待',()=>{equal(A.inspect(doc,{...config,until:'2026-11-30'}).kind,'watch');});
test('单个直接时间按钮可以识别',()=>{page(4,'<div id="suggest_details"><summary id="suggest_details_summary">02.11.2099</summary><button id="single" type="submit">08:30 Uhr auswählen</button></div>');equal(A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]}).el.id,'single');});
const realGrid = await (await fetch('fixtures/superc-time-grid.html')).text();
test('真实 SuperC 日历表格：日期标题与表格为兄弟节点，跳过禁用的 08:00',()=>{
  page(4,realGrid);
  const available=A.slots(doc);
  equal(available.map(slot=>({date:slot.date,time:slot.time})),[{date:'2026-11-11',time:'08:30'}]);
  equal(available[0].el.classList.contains('suggest_btn'),true);
  equal(C.choose(available,{...config,weekdays:[0,1,2,3,4,5,6]},'2026-10-30').time,'08:30');
});
test('真实日历结构选中时间提交按钮，直接进入下一步，无需额外 Weiter',()=>{
  page(4,realGrid.replaceAll('11.11.2026','11.11.2099'));
  const plan=A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]});
  equal(plan.kind,'slot');equal(plan.el.type,'submit');equal(plan.slot,{date:'2099-11-11',time:'08:30'});
});
test('真实表格中时间都变灰时继续监测，不报未知页面',()=>{
  page(4,realGrid.replace('type="submit" class="suggest_btn','disabled type="submit" class="suggest_btn'));
  equal(A.inspect(doc,config).kind,'watch');
});
test('日期标题自身不作为唯一搜索区域，时间方块还可使用 input button',()=>{
  page(4,'<details id="details_suggest_times" open><summary id="suggest_details_summary">11.11.2099</summary><table><tr><td><input id="input-slot" type="button" value="08:15"></td></tr></table></details>');
  equal(A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]}).el.id,'input-slot');
});
test('折叠日期也参与最早时间排序，先展开正确日期',()=>{
  page(4,'<div id="sugg_accordion"><details><summary id="earliest-date">11.11.2099</summary><form class="suggestion_form"><button class="suggest_btn" type="submit">08:00</button></form></details><details open><summary>12.11.2099</summary><button type="submit">08:00</button></details></div>');
  const plan=A.inspect(doc,{...config,weekdays:[0,1,2,3,4,5,6]});equal(plan.kind,'click');equal(plan.el.id,'earliest-date');
});
test('隐藏单选输入使用可见标签点击，保留原单选状态判断',()=>{
  page(4,'<div id="suggest_details"><h3>11.11.2099</h3><input type="radio" id="hidden-radio" name="slot" style="display:none"><label for="hidden-radio" id="radio-tile">08:15</label><button id="WeiterButton">Weiter</button></div>');
  const cfg={...config,weekdays:[0,1,2,3,4,5,6]};equal(A.inspect(doc,cfg).el.id,'radio-tile');
  fixture.querySelector('#hidden-radio').checked=true;equal(A.inspect(doc,cfg).kind,'slot-next');
});
test('姓名、双邮箱和生日格式均正确填入',()=>{
  page(5,'<form><label>Vorname<input name="vorname" required></label><label>Nachname<input name="nachname" required></label><label>E-Mail<input name="email" type="email" required></label><label>E-Mail Wiederholung<input name="email2" type="email" required></label><label>Geburtsdatum<input name="geburtsdatum" required></label></form>');
  const res=A.fill(doc,config);equal(res.missing,[]);equal(fixture.querySelector('[name="vorname"]').value,'Test');equal(fixture.querySelector('[name="email2"]').value,'test@example.org');equal(fixture.querySelector('[name="geburtsdatum"]').value,'03.02.2001');
});
test('生日 date 控件保留 ISO 格式',()=>{page(5,'<label>Geburtsdatum<input type="date" name="birthdate"></label>');A.fill(doc,config);equal(fixture.querySelector('input').value,'2001-02-03');});
test('陌生必填项被报告且不编造值',()=>{page(5,'<label>Aktenzeichen<input name="aktenzeichen" required></label>');equal(A.fill(doc,config).missing,['Aktenzeichen']);equal(fixture.querySelector('input').value,'');});
test('未知字段可按精确 name 映射',()=>{A.fill(doc,{...config,extraFields:{aktenzeichen:'TEST-123'}});equal(fixture.querySelector('input').value,'TEST-123');});
test('不填写隐藏、密码和验证码字段，不勾选声明',()=>{
  page(5,'<input type="hidden" name="email" value="original"><input type="password" name="email"><label>Datenschutz<input type="checkbox" required></label>');A.fill(doc,config);equal(fixture.querySelector('input[type="hidden"]').value,'original');equal(fixture.querySelector('input[type="password"]').value,'');equal(fixture.querySelector('input[type="checkbox"]').checked,false);
});
test('验证码出现时在填写前停止',()=>{page(5,'<input name="captcha" required><input name="vorname">');equal(A.inspect(doc,config).kind,'pause');equal(fixture.querySelector('[name="vorname"]').value,'');});
test('最终提交页仅核对，不点击提交',()=>{page(6,'<button type="submit">Termin verbindlich buchen</button>');equal(A.inspect(doc,config).kind,'review');});
test('通用确认标题不被误报预约成功',()=>{page(6,'<h2>Terminbestätigung</h2>');equal(A.inspect(doc,config).kind,'review');});
test('自动提交核对所选时间、姓名邮箱和表单后，只返回真正的提交按钮',()=>{
  const info=summary.replace('</div>','<dl><dt>Termin</dt><dd>11.11.2099 08:30 Uhr</dd><dt>Persönliche Daten</dt><dd>Test User test@example.org</dd></dl></div>');
  page(6,'<form><button id="submit-final" type="submit">Termin verbindlich buchen</button></form>',info);
  const cfg={...config,autoSubmit:true,weekdays:[0,1,2,3,4,5,6]}, session={selected:{date:'2099-11-11',time:'08:30'}};
  equal(A.inspect(doc,cfg,session).kind,'submit');equal(A.inspect(doc,cfg,session).el.id,'submit-final');
  equal(A.inspect(doc,cfg,{...session,submittedAt:1}).kind,'pause');
  equal(A.inspect(doc,cfg,{selected:{date:'2099-11-11',time:'09:00'}}).kind,'pause');
});
test('自动提交不接受身份不符、必选声明未勾选或不明按钮',()=>{
  const cfg={...config,autoSubmit:true,weekdays:[0,1,2,3,4,5,6]},session={selected:{date:'2099-11-11',time:'08:30'}};
  const info=summary.replace('</div>','<dl><dt>Termin</dt><dd>11.11.2099 08:30 Uhr</dd></dl></div>');
  page(6,'<form><button type="submit">Termin buchen</button></form>',info);equal(A.inspect(doc,cfg,session).kind,'pause');
  page(6,'<form><label>Vorname<input name="vorname" value="Test"></label><label>Nachname<input name="nachname" value="User"></label><label>E-Mail<input name="email" value="test@example.org"></label><input type="checkbox" required><button type="submit">Termin buchen</button></form>',info);equal(A.inspect(doc,cfg,session).kind,'pause');
  fixture.querySelector('[type="checkbox"]').checked=true;equal(A.inspect(doc,cfg,session).kind,'submit');
});
test('明确成功文案可识别，邮件确认另行提醒',()=>{page(6,'Ihr Termin wurde erfolgreich gebucht.');equal(A.inspect(doc,config).kind,'done');page(6,'Bitte bestätigen Sie Ihre E-Mail über den Bestätigungslink.');equal(A.inspect(doc,config).kind,'done');});
const realPersonalData = await (await fetch('fixtures/superc-personaldata.html')).text();
const realFormConfig={...config,autoSubmit:true,weekdays:[0,1,2,3,4,5,6],profile:{...config.profile,phone:'+49123456789'}};
const realFormSession={selected:{date:'2099-11-11',time:'09:00'}};
function personalPage(){fixture.innerHTML=realPersonalData.replaceAll('11.11.2026','11.11.2099');}
test('真实资料页出现内联验证码时仍先填写普通资料',()=>{
  personalPage();
  equal(A.inspect(doc,realFormConfig,realFormSession).kind,'fill');
  equal(fixture.querySelector('#captcha_result').value,'');
});
test('真实表单姓名、双邮箱和必填电话均从配置填写',()=>{
  personalPage();const res=A.fill(doc,realFormConfig);
  equal(res.missing,[]);
  for(const [selector,expected] of [['#vorname','Test'],['#nachname','User'],['#email','test@example.org'],['#emailwhlg','test@example.org'],['#phone','+49123456789']])equal(fixture.querySelector(selector).value,expected);
});
test('真实生日三个数字框分别填写日月年，不写入完整日期字符串',()=>{
  personalPage();A.fill(doc,realFormConfig);
  equal(fixture.querySelector('#geburtsdatumDay').value,'3');
  equal(fixture.querySelector('#geburtsdatumMonth').value,'2');
  equal(fixture.querySelector('#geburtsdatumYear').value,'2001');
});
test('没有保存生日时报告真实表单必填年份，不编造出生年份',()=>{
  personalPage();const res=A.fill(doc,{...realFormConfig,profile:{...realFormConfig.profile,birthDate:''}});
  equal(res.missing.some(name=>/Jahr|geburtsdatumYear/.test(name)),true);
  equal(fixture.querySelector('#geburtsdatumYear').value,'');
});
test('精确字段映射也不能代填验证码或自动勾选同意项',()=>{
  personalPage();A.fill(doc,{...realFormConfig,extraFields:{captcha_code:'DO-NOT-FILL',agreementChecked:'true',hunangskrukka:'DO-NOT-FILL'}});
  equal(fixture.querySelector('#captcha_result').value,'');
  equal(fixture.querySelector('[name="agreementChecked"]').checked,false);
  equal(fixture.querySelector('#hunangskrukka').value,'');
});
test('真实表单人工项明确区分验证码和必选同意，完成后可重新核对',()=>{
  personalPage();A.fill(doc,realFormConfig);
  const pending=A.humanRequirements(doc);equal(pending.captchaFields.length,1);equal(pending.captchaFields[0].id,'captcha_result');equal(pending.missing.length>=2,true);
  fixture.querySelector('#captcha_result').value='LOCAL-TEST';fixture.querySelector('[name="agreementChecked"]').checked=true;
  equal(A.humanRequirements(doc).missing,[]);
});
test('真实 Reservieren 控件只有在人工项完成且摘要一致时允许提交',()=>{
  personalPage();A.fill(doc,realFormConfig);
  equal(A.submission(doc,realFormConfig,realFormSession).kind==='submit',false);
  fixture.querySelector('#captcha_result').value='LOCAL-TEST';fixture.querySelector('[name="agreementChecked"]').checked=true;
  const plan=A.submission(doc,realFormConfig,realFormSession);equal(plan.kind,'submit');equal(plan.el.id,'chooseTerminButton');equal(plan.slot,realFormSession.selected);
  equal(A.submission(doc,realFormConfig,{selected:{date:'2099-11-11',time:'08:30'}}).kind==='submit',false);
});
test('真实表单邮件帮助和隐藏成功文案不会误报已经预约成功',()=>{
  personalPage();equal(A.inspect(doc,realFormConfig,realFormSession).kind,'fill');
  fixture.querySelector('#privacy_dialog').innerHTML='<h1>Schritt 6 von 6</h1><p>Ihr Termin wurde erfolgreich gebucht.</p>';
  equal(A.inspect(doc,realFormConfig,realFormSession).kind,'fill');
});
test('没有本轮待确认许可的双按钮弹窗保留人工处理',()=>{
  const info=summary.replace('</div>','<dl><dt>Termin</dt><dd>11.11.2099 09:00 Uhr</dd></dl></div>');
  page(4,'<div id="TevisDialog" role="dialog"><p>Unbekannter Hinweis nach der Terminauswahl.</p><button id="dialog-left" style="background:blue">Zurück</button><button id="dialog-right" style="background:blue">Weiter</button></div>',info);
  const plan=A.inspect(doc,realFormConfig,realFormSession);equal(plan.kind,'manual');equal(!!plan.el,false);
});
test('诊断仅记录表单结构，不带填写值、勾选状态、验证码图片或查询参数',()=>{
  personalPage();A.fill(doc,realFormConfig);
  fixture.querySelector('#vorname').value='PRIVATE_INPUT_SENTINEL';fixture.querySelector('#captcha_result').value='CAPTCHA_SENTINEL';fixture.querySelector('[name="agreementChecked"]').checked=true;
  fixture.querySelector('#captcha_image').setAttribute('src','data:image/svg+xml,IMAGE_SECRET_SENTINEL');
  fixture.querySelector('form').setAttribute('action','/auslaenderamt/personaldata?session=QUERY_SECRET_SENTINEL');
  const diagnostic=JSON.stringify(A.diagnostic(doc));
  for(const marker of ['PRIVATE_INPUT_SENTINEL','CAPTCHA_SENTINEL','IMAGE_SECRET_SENTINEL','QUERY_SECRET_SENTINEL'])equal(diagnostic.includes(marker),false);
  equal(/"checked"\s*:/.test(diagnostic),false);
  equal(diagnostic.includes('vorname'),true);equal(diagnostic.includes('Reservieren'),true);
});
const inferredSlotDialog = await (await fetch('fixtures/slot-confirm-dialog.html')).text();
const slotDialogSession={...realFormSession,awaitingSlotDialog:true};
function slotDialogPage(stage=4,info=summary){page(stage,inferredSlotDialog,info);}
function slotDialogPlan(session=slotDialogSession,cfg=realFormConfig){return A.inspect(doc,cfg,session);}
function noSlotDialogClick(session=slotDialogSession,cfg=realFormConfig){const plan=slotDialogPlan(session,cfg);equal(plan.kind,'manual');equal(!!plan.el,false);}
test('推断的选时确认窗口：仅本轮待确认状态下识别底部右侧蓝色继续按钮',()=>{
  slotDialogPage();const plan=slotDialogPlan();equal(plan.kind,'slot-confirm');equal(plan.el.id,'slot-dialog-right');
});
test('选时确认按视觉位置选右侧，CSS顺序与DOM逆序时仍不误点左边',()=>{
  slotDialogPage();const footer=fixture.querySelector('.modal-footer'),left=fixture.querySelector('#slot-dialog-left'),right=fixture.querySelector('#slot-dialog-right');
  left.style.order='1';right.style.order='2';footer.replaceChildren(right,left);
  equal(footer.firstElementChild.id,'slot-dialog-right');equal(right.getBoundingClientRect().left>left.getBoundingClientRect().left,true);
  const plan=slotDialogPlan();equal(plan.kind,'slot-confirm');equal(plan.el.id,'slot-dialog-right');
});
test('右侧OK含图标可继续，页头关闭按钮不参与底部双按钮选择',()=>{
  slotDialogPage();fixture.querySelector('#slot-dialog-right').innerHTML='<span aria-hidden="true">✓</span> OK';
  const plan=slotDialogPlan();equal(plan.kind,'slot-confirm');equal(plan.el.id,'slot-dialog-right');
});
test('选时后双蓝按钮窗口没有本轮待确认许可时继续保持人工处理',()=>{
  slotDialogPage();noSlotDialogClick(realFormSession);noSlotDialogClick({...slotDialogSession,awaitingSlotDialog:false});
});
test('选时确认只适用于第4或第5步，不作用于其他步骤',()=>{
  slotDialogPage(5);equal(slotDialogPlan().kind,'slot-confirm');
  for(const stage of [1,2,3,6]){slotDialogPage(stage);noSlotDialogClick();}
});
test('未选中时间、已提交或日期不符合配置时不会自动确认窗口',()=>{
  slotDialogPage();noSlotDialogClick({awaitingSlotDialog:true});noSlotDialogClick({...slotDialogSession,submittedAt:1});noSlotDialogClick(slotDialogSession,{...realFormConfig,until:'2099-11-01'});
});
test('选时确认仍须核实RWTH学生和SuperC分类',()=>{
  slotDialogPage(4,'<div id="details_infobox">FH Studenten · Andere Außenstelle</div>');noSlotDialogClick();
});
test('含DSGVO同意文字的双蓝按钮窗口不会自动确认',()=>{
  slotDialogPage();fixture.querySelector('#TevisDialog p').textContent='Ich willige in die Verarbeitung meiner Daten ein. Datenschutz und DSGVO.';noSlotDialogClick();
});
test('含可编辑字段、勾选项或验证码的选时窗口均需人工处理',()=>{
  for(const extra of ['<input name="other" type="text">','<input type="checkbox">','<input name="captcha_code" id="captcha_result">']){
    slotDialogPage();fixture.querySelector('#TevisDialog p').insertAdjacentHTML('afterend',extra);noSlotDialogClick();
  }
});
test('时间失效或错误提示不会被当成可以继续的选时窗口',()=>{
  for(const message of ['Fehler: Der Termin ist nicht mehr verfügbar.','Die Sitzung ist abgelaufen.','Error: Please try again.']){
    slotDialogPage();fixture.querySelector('#TevisDialog p').textContent=message;noSlotDialogClick();
  }
});
test('右侧返回、取消或最终预约按钮不会被自动点击',()=>{
  for(const label of ['Zurück','Abbrechen','Reservieren','Termin buchen','Termin verbindlich buchen','Bestätigen','Termin anfragen']){
    slotDialogPage();fixture.querySelector('#slot-dialog-right').textContent=label;noSlotDialogClick();
  }
});
test('关联表单的submit控件不作为弹窗普通继续按钮',()=>{
  slotDialogPage();fixture.insertAdjacentHTML('beforeend','<form id="slot-modal-form"></form>');const right=fixture.querySelector('#slot-dialog-right');right.type='submit';right.setAttribute('form','slot-modal-form');noSlotDialogClick();
});
test('同时出现多个可见模态窗口时不猜测要确认哪一个',()=>{
  slotDialogPage();fixture.insertAdjacentHTML('beforeend','<div role="dialog" class="modal" style="display:block"><div class="modal-content"><p>Anderer Hinweis</p><button type="button">OK</button></div></div>');noSlotDialogClick();
});
test('非蓝色、禁用或不在同一底部行的按钮不匹配选时确认',()=>{
  slotDialogPage();fixture.querySelector('#slot-dialog-right').style.background='rgb(200,30,30)';noSlotDialogClick();
  slotDialogPage();fixture.querySelector('#slot-dialog-right').disabled=true;noSlotDialogClick();
  slotDialogPage();fixture.querySelector('.modal-footer').style.display='block';fixture.querySelector('#slot-dialog-right').style.display='block';noSlotDialogClick();
});
test('已知第2步RWTH说明仍通过明确的OKButton路径继续',()=>{
  page(2,'<div role="dialog" class="modal"><div id="TevisDialog" class="modal-content"><h3>Anliegen: RWTH Studenten</h3><p>Bekannter Servicehinweis.</p><button id="OKButton" type="button">OK</button></div></div>','');
  const plan=A.inspect(doc,realFormConfig);equal(plan.kind,'click');equal(plan.el.id,'OKButton');
});
fixture.hidden=true;document.getElementById('summary').textContent=`${passed} passed, ${failed} failed`;
document.documentElement.dataset.testResult=failed?'failed':'passed';
})().catch(error=>{document.getElementById('summary').textContent='Test harness error: '+error.message;document.documentElement.dataset.testResult='failed';});
