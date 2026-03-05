const dayjs = require("dayjs");

function upcomingRange() {
  return {
    start: dayjs().startOf("day").format("YYYY-MM-DD"),
    end: dayjs().add(7, "day").endOf("day").format("YYYY-MM-DD")
  };
}

module.exports = {
  upcomingRange
};
