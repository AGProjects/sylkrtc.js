
NODE_MODULES_DIR = node_modules
DIST_DIR = dist
GULP = $(NODE_MODULES_DIR)/.bin/gulp

.PHONY: all clean distclean min watch

all:
	$(GULP) dist

clean:
	rm -rf $(DIST_DIR)

distclean: clean
	rm -rf $(NODE_MODULES_DIR)

min:
	$(GULP) --type production

watch:
	$(GULP) watch
