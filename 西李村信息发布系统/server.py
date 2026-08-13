"""
西李村综合信息发布系统 - 后端服务
功能：土地管理可视化、农产品价格、农业政策新闻、土壤数据
"""
import json, os, random
from datetime import datetime, timedelta
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="西李村综合信息发布系统", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ========== 西李村基本信息 ==========

@app.get("/api/village")
def get_village():
    return {
        "name": "西李村",
        "location": "河南省商丘市睢阳区郭村镇",
        "coordinates": {"lat": 34.2800, "lng": 115.5800},
        "area": {"total": 2850, "farmland": 2180, "woodland": 320, "water": 150, "construction": 200},
        "population": {"households": 486, "total": 1952, "labor": 1120, "migrant": 580},
        "economy": {"main_crops": "小麦、玉米、花生、金银花", "village_enterprises": "建材厂、农产品加工厂", "avg_income": 18600},
        "infrastructure": {"roads": "村村通硬化路全覆盖", "water": "自来水入户率100%", "internet": "光纤覆盖率达95%"},
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }

# ========== 土地数据 ==========

def generate_land_data():
    return {
        "total_area": 2850, "farmland": 2180, "woodland": 320, "water": 150, "construction": 200,
        "plots": [
            {"id":"A1","name":"村东小麦田","area":450,"crop":"冬小麦","status":"生长期","soil_type":"壤土","manager":"李大国","lat":34.2845,"lng":115.5750},
            {"id":"A2","name":"村南玉米地","area":380,"crop":"夏玉米","status":"已收割","soil_type":"砂壤土","manager":"刘丰收","lat":34.2835,"lng":115.5850},
            {"id":"B1","name":"村西蔬菜大棚","area":120,"crop":"番茄/黄瓜","status":"采摘期","soil_type":"壤土","manager":"王翠花","lat":34.2785,"lng":115.5725},
            {"id":"B2","name":"果园基地","area":280,"crop":"苹果/梨","status":"挂果期","soil_type":"黄壤土","manager":"张果园","lat":34.2825,"lng":115.5865},
            {"id":"C1","name":"河滩试验田","area":150,"crop":"大豆","status":"休耕","soil_type":"冲积土","manager":"村委会","lat":34.2760,"lng":115.5740},
            {"id":"C2","name":"坡地花生区","area":200,"crop":"花生","status":"成熟期","soil_type":"砂土","manager":"赵铁柱","lat":34.2770,"lng":115.5810},
            {"id":"D1","name":"林地保护区","area":320,"crop":"杨树/槐树","status":"正常","soil_type":"褐土","manager":"村委会","lat":34.2775,"lng":115.5870},
            {"id":"E1","name":"村北药材基地","area":180,"crop":"金银花","status":"采摘期","soil_type":"壤土","manager":"马药材","lat":34.2855,"lng":115.5800},
        ],
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }

def generate_price_data():
    base = {"小麦":2.48,"玉米":2.30,"大豆":5.20,"花生":8.50,"番茄":3.20,"黄瓜":2.80,"苹果":5.60,"梨":4.20,"金银花":95.00,"鸡蛋":9.20,"猪肉":24.00,"牛肉":68.00}
    items = []
    for name, b in base.items():
        ch = round(random.uniform(-0.15,0.15),2)
        cur = round(b+ch,2)
        trend = "up" if ch>0.01 else "down" if ch<-0.01 else "flat"
        items.append({"name":name,"price":cur,"change":ch,"trend":trend,"unit":"元/公斤"})
    return {"items":items,"source":"商丘市农产品批发市场","updated_at":datetime.now().strftime("%Y-%m-%d %H:%M")}

def generate_policy_news():
    return {"items":[
        {"id":1,"title":"河南省2026年惠农补贴政策实施细则发布","date":"2026-07-25","source":"河南省农业农村厅","summary":"明确耕地地力保护补贴、农机购置补贴等标准……"},
        {"id":2,"title":"商丘市推进高标准农田建设三年行动计划","date":"2026-07-20","source":"商丘市农业农村局","summary":"到2028年新建高标准农田50万亩，亩均投资不低于3000元……"},
        {"id":3,"title":"睢阳区开展2026年新型职业农民培训通知","date":"2026-07-18","source":"睢阳区农业农村局","summary":"面向全区招收200名学员，开设种植、养殖、电商等专题班……"},
        {"id":4,"title":"最新农产品质量安全监测结果公布","date":"2026-07-15","source":"河南省市场监管局","summary":"全省抽检合格率达98.7%，蔬菜水果合格率稳步提升……"},
        {"id":5,"title":"科技特派员助力乡村振兴典型案例征集","date":"2026-07-12","source":"河南省科技厅","summary":"面向全省征集科技特派员服务典型案例，优秀案例全省推广……"},
        {"id":6,"title":"郭村镇关于做好秋收秋种工作的通知","date":"2026-07-08","source":"郭村镇人民政府","summary":"要求各村提前检修农机具，做好农资储备……"},
    ],"updated_at":datetime.now().strftime("%Y-%m-%d %H:%M")}

# ========== 土壤模拟数据 ==========

STATIONS = [
    {"station": "村北药材基地", "base_temp": 28.5, "base_moisture": 45.0, "base_ph": 5.8, "base_n": 120, "base_p": 35, "base_k": 180},
    {"station": "村东小麦田",   "base_temp": 26.0, "base_moisture": 55.0, "base_ph": 6.5, "base_n": 90,  "base_p": 40, "base_k": 200},
    {"station": "村西蔬菜大棚", "base_temp": 30.0, "base_moisture": 65.0, "base_ph": 6.8, "base_n": 150, "base_p": 50, "base_k": 220},
]

def generate_soil_records(days=7):
    records = []
    now = datetime.now()
    for i in range(days * 24, -1, -1):
        t = now - timedelta(hours=i)
        for s in STATIONS:
            temp = round(s["base_temp"] + random.uniform(-3, 3) + 5 * random.random(), 1)
            moisture = round(s["base_moisture"] + random.uniform(-10, 10), 1)
            ph = round(s["base_ph"] + random.uniform(-0.5, 0.5), 2)
            n = round(s["base_n"] + random.uniform(-20, 20), 1)
            p = round(s["base_p"] + random.uniform(-10, 10), 1)
            k = round(s["base_k"] + random.uniform(-30, 30), 1)

            # 村北药材基地：模拟严重酸化 + 干旱
            if s["station"] == "村北药材基地":
                ph = round(ph - 1.2, 2)
                moisture = round(moisture * 0.4, 1)

            # 村东小麦田：模拟氮偏低
            if s["station"] == "村东小麦田":
                n = round(n * 0.7, 1)

            # 状态判定
            if moisture < 20 or ph < 5.0:
                status = "severe"
            elif moisture < 35 or ph < 5.5 or n < 70:
                status = "abnormal"
            else:
                status = "normal"

            records.append({
                "station": s["station"],
                "time": t.strftime("%Y-%m-%d %H:%M"),
                "temperature": temp,
                "moisture": moisture,
                "ph": ph,
                "nitrogen": n,
                "phosphorus": p,
                "potassium": k,
                "status": status,
            })
    return records

# ========== API ==========

@app.get("/api/village")
def api_village(): return get_village()

@app.get("/api/land")
def get_land(): return generate_land_data()

@app.get("/api/prices")
def get_prices(): return generate_price_data()

@app.get("/api/policies")
def get_policies(): return generate_policy_news()

@app.get("/api/soil/latest")
def soil_latest():
    return {"status":"reserved","message":"土壤传感器数据接口已预留，待设备部署后接入",
            "expected_fields":{"temperature":"土壤温度(℃)","moisture":"土壤湿度(%)","ph":"土壤pH值",
            "nitrogen":"氮含量(mg/kg)","phosphorus":"磷含量(mg/kg)","potassium":"钾含量(mg/kg)",
            "organic_matter":"有机质(g/kg)","conductivity":"电导率(μS/cm)"}}

@app.post("/api/soil/upload")
def soil_upload(data:dict=None):
    return {"status":"received","message":"数据已接收（预留接口）","data":data}

@app.get("/api/soil/history")
def soil_history(days:int=Query(default=7,ge=1,le=30)):
    records = generate_soil_records(days)
    return {
        "status": "ok",
        "days": days,
        "station": "all",
        "count": len(records),
        "records": records,
    }

@app.get("/")
def index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
