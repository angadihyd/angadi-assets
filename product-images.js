/* Live product photos for cart / checkout / orders pages.
   Those pages carry a hardcoded name→image list that falls back to the mutton
   photo for any product it doesn't know (ghee, kheema, boneless, anything new).
   This swaps each product image (matched by its alt = product name) for the
   photo stored on the product itself in the database. */
(function(){
  var KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlqdmt2Z216ampod3Zyd3RsYWRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MDU2MDcsImV4cCI6MjA5NjA4MTYwN30.Kv1uqldZdoWjNnMbHMD2xuZ5i5tnl6cdvapgIIN6vJQ';
  var cs=document.currentScript, BASE=(cs&&cs.getAttribute('data-base'))||'';
  var map=null;
  function abs(s){ s=String(s||''); return /^(https?:|data:)/.test(s)?s:BASE+s.replace(/^(\.\.\/)+/,'').replace(/^\//,''); }
  function patch(){
    if(!map) return;
    document.querySelectorAll('img[alt]').forEach(function(im){
      var u=map[im.getAttribute('alt')];
      if(u && im.getAttribute('data-pimg')!==u){ im.setAttribute('data-pimg',u); if(im.getAttribute('src')!==u) im.setAttribute('src',u); }
    });
  }
  fetch('https://www.angadi.farm/api/supabase/rest/v1/products?select=name,image&active=eq.true',{headers:{apikey:KEY,Authorization:'Bearer '+KEY}})
    .then(function(r){return r.ok?r.json():[];})
    .then(function(rows){
      map={}; (rows||[]).forEach(function(p){ if(p&&p.name&&p.image) map[p.name]=abs(p.image); });
      patch();
      new MutationObserver(patch).observe(document.body,{childList:true,subtree:true});
    }).catch(function(){});
})();
