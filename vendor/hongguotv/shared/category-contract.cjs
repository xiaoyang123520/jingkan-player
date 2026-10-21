(function(root){
  const types=[{id:'real-drama',name:'真人剧'},{id:'comic-drama',name:'漫剧'},{id:'ai-drama',name:'AI剧'}];
  const fail=(message,status=502)=>{const error=new Error(message);error.status=status;throw error;};
  function officialCategory(data,type,tag='',page=1){
    if(!types.some(row=>row.id===type))fail('不支持的分类类型',400);
    if(!Number.isSafeInteger(page)||page<1||page>10000)fail('分类页码无效',400);
    const source=data?.loaderData?.['category_$'];
    if(!source || source.isSuccess===false || !Array.isArray(source.recommendList) || !Array.isArray(source.selectorList))fail('官网分类数据暂不可用，请重试');
    if(source.categoryRoute?.contentType!==type)fail('官网返回的分类类型不匹配');
    const tags=[];const seen=new Set();
    for(const group of source.selectorList)for(const item of group.items||[]){
      const id=item.selector_item_id,name=item.show_name;
      if(typeof id!=='string'||!/^[-a-z]+$/.test(id)||typeof name!=='string'||!name.trim()||seen.has(id))continue;
      seen.add(id);tags.push({id,name,categoryIds:(item.category_json_ids||[]).map(String)});
    }
    if(tag){
      const selected=tags.find(row=>row.id===tag);
      if(!selected)fail('当前类型不支持该题材',400);
      const ids=(source.categoryRoute.categoryJsonIds||[]).map(String);
      if(!selected.categoryIds.length||selected.categoryIds.some(id=>!ids.includes(id)))fail('官网返回的题材筛选不匹配');
    }
    const pagination=source.pagination||{};
    if(Number(pagination.pageNum)!==page)fail('官网返回的分类页码不匹配');
    const path=`/category/${type}${tag?'/'+tag:''}`;
    if(source.categoryRoute.canonicalPath!==path)fail('官网分类路径不匹配');
    return {types,type,tag,page,tags,rows:source.recommendList,sourceUrl:`https://hongguoduanju.com${path}${page>1?'?page='+page:''}`,pagination:{pageNum:page,pageSize:Number(pagination.pageSize)||24,total:Number(pagination.total)||0,totalPages:Number(pagination.totalPages)||1}};
  }
  root.officialCategory=officialCategory;
  if(typeof module!=='undefined'&&module.exports)module.exports={officialCategory,types};
})(globalThis);
